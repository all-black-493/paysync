import type { BalanceAccount } from '@paysync/daraja'
import { raiseException, schema, type Tx } from '@paysync/db'
import { and, desc, eq, gt, lte, sql } from 'drizzle-orm'
import type { WorkerDeps } from '../deps.js'

const { balanceSnapshot, mpesaTransaction } = schema

type RequestRow = typeof schema.darajaRequest.$inferSelect

const account = (accounts: readonly BalanceAccount[], ...names: string[]) =>
  accounts.find((a) => names.includes(a.name))?.available ?? 0n

/** Stores a balance snapshot and raises a variance when the change is not explained by verified receipts. */
export async function applyAccountBalance(deps: WorkerDeps, tx: Tx, request: RequestRow, accounts: readonly BalanceAccount[], reportedAt: Date) {
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
