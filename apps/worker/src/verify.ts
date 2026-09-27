import { raiseException, schema, withOrg, type JobPayload } from '@paysync/db'
import { rerouteUnrouted } from '@paysync/ingest'
import { and, eq, gt, inArray, sql } from 'drizzle-orm'
import type { WorkerDeps } from './deps.js'
import { failVerification, markVerified } from './verification.js'

const { darajaRequest, mpesaTransaction, shortcode, stkRequest } = schema

export type VerifyOutcome = 'verified' | 'failed' | 'waiting' | 'skipped'

/** A Transaction Status request still waiting for its result is not sent again. */
const RESULT_WAIT_MS = 10 * 60_000

async function claim(deps: WorkerDeps, { orgId, transactionId }: JobPayload<'verify_transaction'>) {
  return withOrg(deps.db, orgId, async (tx) => {
    await tx.select({ id: mpesaTransaction.id }).from(mpesaTransaction).where(eq(mpesaTransaction.id, transactionId)).for('update')
    const [row] = await tx
      .select({ t: mpesaTransaction, code: shortcode.code, initiatorEnabled: shortcode.initiatorEnabled, stk: stkRequest })
      .from(mpesaTransaction)
      .innerJoin(shortcode, eq(shortcode.id, mpesaTransaction.shortcodeId))
      .leftJoin(stkRequest, eq(stkRequest.id, mpesaTransaction.stkRequestId))
      .where(eq(mpesaTransaction.id, transactionId))
    if (row?.t.status !== 'pending_verification') return null
    await tx
      .update(mpesaTransaction)
      .set({
        verificationAttempts: row.t.verificationAttempts + 1,
        lastVerificationAt: sql`now()`,
        version: row.t.version + 1,
      })
      .where(eq(mpesaTransaction.id, transactionId))
    return { ...row, attempt: row.t.verificationAttempts + 1 }
  })
}

type Claimed = NonNullable<Awaited<ReturnType<typeof claim>>>

async function verifyStk(deps: WorkerDeps, orgId: string, c: Claimed): Promise<VerifyOutcome> {
  const request = c.stk
  if (!request?.checkoutRequestId) return 'waiting'
  const query = await deps.daraja.stkQuery(c.code, request.checkoutRequestId)
  if (query.outcome === 'pending' || query.outcome === 'unknown') return 'waiting'
  return withOrg(deps.db, orgId, async (tx) => {
    if (query.outcome !== 'succeeded') {
      await failVerification(tx, c.t.id, `STK Query reports "${query.resultDesc}"`, {
        method: 'stk_query',
        resultCode: query.resultCode,
      })
      return 'failed'
    }
    // STK Query confirms the push was paid but returns no amount: only what we asked for is confirmed.
    if (request.amount !== c.t.amount) {
      await failVerification(tx, c.t.id, 'the callback amount differs from the amount requested', {
        method: 'stk_query',
        requestedMinor: request.amount.toString(),
        callbackMinor: c.t.amount.toString(),
      })
      return 'failed'
    }
    return (await markVerified(tx, c.t.id, 'stk_query')) ? 'verified' : 'skipped'
  })
}

async function requestTransactionStatus(deps: WorkerDeps, orgId: string, c: Claimed): Promise<VerifyOutcome> {
  if (!c.initiatorEnabled || !deps.daraja.hasInitiator || !deps.resultUrls) {
    deps.logger.warn(
      { transactionId: c.t.id, initiatorEnabled: c.initiatorEnabled, initiator: deps.daraja.hasInitiator, resultUrls: deps.resultUrls !== null },
      'no route to verify this C2B payment yet (Transaction Status unavailable); waiting for Pull Transactions',
    )
    return 'waiting'
  }
  const urls = deps.resultUrls('txn')
  const request = await withOrg(deps.db, orgId, async (tx) => {
    const [open] = await tx
      .select({ id: darajaRequest.id })
      .from(darajaRequest)
      .where(
        and(
          eq(darajaRequest.transactionId, c.t.id),
          inArray(darajaRequest.status, ['initiated', 'accepted']),
          gt(darajaRequest.createdAt, new Date(deps.now().getTime() - RESULT_WAIT_MS)),
        ),
      )
      .limit(1)
    if (open) return null
    const [created] = await tx
      .insert(darajaRequest)
      .values({ orgId, shortcodeId: c.t.shortcodeId, kind: 'transaction_status', transactionId: c.t.id, receiptNumber: c.t.receiptNumber })
      .returning()
    return created ?? null
  })
  if (!request) return 'waiting'

  let response
  try {
    response = await deps.daraja.transactionStatus({ shortcode: c.code, receiptNumber: c.t.receiptNumber, ...urls })
  } catch (error) {
    await withOrg(deps.db, orgId, (tx) =>
      tx
        .update(darajaRequest)
        .set({ status: 'failed', resultDesc: error instanceof Error ? error.message.slice(0, 500) : 'request failed', version: request.version + 1 })
        .where(eq(darajaRequest.id, request.id)),
    )
    throw error
  }
  await withOrg(deps.db, orgId, (tx) =>
    tx
      .update(darajaRequest)
      .set({
        status: 'accepted',
        originatorConversationId: response.OriginatorConversationID,
        conversationId: response.ConversationID,
        resultCode: response.ResponseCode,
        resultDesc: response.ResponseDescription,
        version: request.version + 1,
      })
      .where(eq(darajaRequest.id, request.id)),
  )
  // The result may have arrived before the ConversationID was saved.
  await rerouteUnrouted(deps, 'transaction_status_result', response.ConversationID)
  return 'waiting'
}

export async function verifyTransaction(deps: WorkerDeps, payload: JobPayload<'verify_transaction'>): Promise<VerifyOutcome> {
  const claimed = await claim(deps, payload)
  if (!claimed) return 'skipped'
  let outcome: VerifyOutcome
  if (claimed.t.source === 'stk') {
    outcome = await verifyStk(deps, payload.orgId, claimed)
  } else if (claimed.t.source === 'pull') {
    // Pulled from Safaricom by us: the record is the verification.
    outcome = (await withOrg(deps.db, payload.orgId, (tx) => markVerified(tx, claimed.t.id, 'pull'))) ? 'verified' : 'skipped'
  } else {
    outcome = await requestTransactionStatus(deps, payload.orgId, claimed)
  }
  if (outcome === 'waiting' && claimed.attempt >= deps.policy.maxAttempts) {
    await withOrg(deps.db, payload.orgId, (tx) =>
      raiseException(tx, {
        orgId: payload.orgId,
        kind: 'verification_failed',
        priority: 'normal',
        summary: `Payment ${claimed.t.receiptNumber} could not be verified with Safaricom after ${claimed.attempt} attempts`,
        transactionId: claimed.t.id,
        details: { attempts: claimed.attempt, source: claimed.t.source },
        dedupeKey: `unverified:${claimed.t.id}`,
      }),
    )
  }
  deps.logger.info({ transactionId: claimed.t.id, attempt: claimed.attempt, outcome }, 'verification attempt')
  return outcome
}
