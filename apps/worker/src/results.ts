import {
  DarajaResult,
  normalizeAccountBalanceResult,
  normalizeTransactionStatusResult,
  type BalanceAccount,
  type TransactionStatusResult,
} from '@paysync/daraja'
import { raiseException, schema, withOrg, type JobPayload, type Tx } from '@paysync/db'
import { unsealPayload } from '@paysync/ingest'
import { and, desc, eq, gt, lte, or, sql } from 'drizzle-orm'
import type { WorkerDeps } from './deps.js'
import { failVerification, markVerified } from './verification.js'

const { balanceSnapshot, darajaRequest, inboundEvent, mpesaTransaction, shortcode } = schema

type RequestRow = typeof darajaRequest.$inferSelect

function mismatches(result: TransactionStatusResult, expected: { receipt: string; amount: bigint; shortcode: string }): string[] {
  const problems: string[] = []
  if (result.receiptNumber !== expected.receipt) problems.push(`receipt ${String(result.receiptNumber)} ≠ ${expected.receipt}`)
  if (result.amountMinor !== expected.amount) problems.push(`amount ${String(result.amountMinor)} ≠ ${expected.amount}`)
  if (result.transactionStatus !== 'Completed') problems.push(`M-Pesa status is ${String(result.transactionStatus)}`)
  if (result.creditParty !== null && !result.creditParty.startsWith(`${expected.shortcode} `)) {
    problems.push('credited to a different shortcode')
  }
  return problems
}

async function applyTransactionStatus(deps: WorkerDeps, tx: Tx, request: RequestRow, result: TransactionStatusResult) {
  if (!request.transactionId) return
  // Any other code (e.g. a rejected initiator credential) says nothing about the payment: stay pending, fail closed.
  if (!result.succeeded) {
    deps.logger.warn({ requestId: request.id, resultCode: result.resultCode, resultDesc: result.resultDesc }, 'Transaction Status did not succeed')
    return
  }
  const [row] = await tx
    .select({ receipt: mpesaTransaction.receiptNumber, amount: mpesaTransaction.amount, code: shortcode.code })
    .from(mpesaTransaction)
    .innerJoin(shortcode, eq(shortcode.id, mpesaTransaction.shortcodeId))
    .where(eq(mpesaTransaction.id, request.transactionId))
  if (!row) return
  const problems = mismatches(result, { receipt: row.receipt, amount: row.amount, shortcode: row.code })
  if (problems.length === 0) {
    await markVerified(tx, request.transactionId, 'transaction_status')
    return
  }
  await failVerification(tx, request.transactionId, 'Transaction Status disagrees with the callback', {
    method: 'transaction_status',
    problems,
    conversationId: result.conversationId,
  })
}

const account = (accounts: readonly BalanceAccount[], ...names: string[]) =>
  accounts.find((a) => names.includes(a.name))?.available ?? 0n

async function applyAccountBalance(deps: WorkerDeps, tx: Tx, request: RequestRow, accounts: readonly BalanceAccount[], reportedAt: Date) {
  const utility = account(accounts, 'Utility Account', 'Merchant Account')
  const working = account(accounts, 'Working Account')
  const chargesPaid = account(accounts, 'Charges Paid Account')
  const [previous] = await tx
    .select()
    .from(balanceSnapshot)
    .where(and(eq(balanceSnapshot.shortcodeId, request.shortcodeId), lte(balanceSnapshot.reportedAt, reportedAt)))
    .orderBy(desc(balanceSnapshot.reportedAt))
    .limit(1)
  const [snapshot] = await tx
    .insert(balanceSnapshot)
    .values({
      orgId: request.orgId,
      shortcodeId: request.shortcodeId,
      darajaRequestId: request.id,
      utility,
      working,
      chargesPaid,
      accounts: accounts.map((a) => ({ ...a, available: a.available.toString(), uncleared: a.uncleared.toString(), reserved: a.reserved.toString() })),
      reportedAt,
    })
    .onConflictDoNothing({ target: balanceSnapshot.darajaRequestId })
    .returning()
  if (!snapshot || !previous) return

  // Settlement moves money between these accounts; only money leaving all three is unexplained here.
  const actual = utility + working + chargesPaid - (previous.utility + previous.working + previous.chargesPaid)
  const [received] = await tx
    .select({ total: sql<string>`coalesce(sum(${mpesaTransaction.amount}), 0)::text` })
    .from(mpesaTransaction)
    .where(
      and(
        eq(mpesaTransaction.shortcodeId, request.shortcodeId),
        eq(mpesaTransaction.status, 'verified'),
        gt(mpesaTransaction.transactedAt, previous.reportedAt),
        lte(mpesaTransaction.transactedAt, reportedAt),
      ),
    )
  const expected = BigInt(received?.total ?? '0')
  const variance = actual - expected
  deps.logger.info({ shortcodeId: request.shortcodeId, actual: actual.toString(), expected: expected.toString() }, 'balance check')
  if (variance === 0n) return
  await raiseException(tx, {
    orgId: request.orgId,
    kind: 'balance_variance',
    priority: 'high',
    summary: `M-Pesa balance moved by ${actual} but verified receipts total ${expected} (variance ${variance}, minor units)`,
    details: {
      from: previous.reportedAt.toISOString(),
      to: reportedAt.toISOString(),
      actualMinor: actual.toString(),
      verifiedReceiptsMinor: expected.toString(),
      varianceMinor: variance.toString(),
      note: 'Withdrawals and charges are not ingested yet and appear as variance.',
    },
    dedupeKey: `balance_variance:${snapshot.id}`,
  })
}

export async function applyDarajaResult(deps: WorkerDeps, { orgId, inboundEventId }: JobPayload<'apply_daraja_result'>): Promise<void> {
  await withOrg(deps.db, orgId, async (tx) => {
    const [event] = await tx.select().from(inboundEvent).where(eq(inboundEvent.id, inboundEventId))
    if (!event) return
    const body = unsealPayload(event.payload, deps.pii)
    const ids = DarajaResult.safeParse(body)
    const conversationId = ids.success ? ids.data.Result.ConversationID : event.externalId
    const originatorId = ids.success ? ids.data.Result.OriginatorConversationID : event.externalId
    const [request] = await tx
      .select()
      .from(darajaRequest)
      .where(or(eq(darajaRequest.conversationId, conversationId), eq(darajaRequest.originatorConversationId, originatorId)))
      .for('update')
    if (!request) return
    if (request.status === 'completed' || request.status === 'failed') return

    if (event.source === 'queue_timeout' || !ids.success) {
      await tx
        .update(darajaRequest)
        .set({ status: event.source === 'queue_timeout' ? 'timed_out' : 'failed', version: request.version + 1 })
        .where(eq(darajaRequest.id, request.id))
      return
    }

    const status = ids.data.Result.ResultCode === '0' ? 'completed' : 'failed'
    await tx
      .update(darajaRequest)
      .set({ status, resultCode: ids.data.Result.ResultCode, resultDesc: ids.data.Result.ResultDesc.slice(0, 500), version: request.version + 1 })
      .where(eq(darajaRequest.id, request.id))

    if (request.kind === 'transaction_status') {
      await applyTransactionStatus(deps, tx, request, normalizeTransactionStatusResult(ids.data))
    } else {
      const result = normalizeAccountBalanceResult(ids.data)
      if (result.succeeded) await applyAccountBalance(deps, tx, request, result.accounts, result.completedAt ?? event.receivedAt)
    }
  })
}
