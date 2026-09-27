import { enqueueJob, schema, withOrg, type Db, type Tx } from '@paysync/db'
import { and, eq, gt, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm'
import type { WorkerDeps } from './deps.js'

const { mpesaTransaction, organization, shortcode, stkRequest } = schema

const BATCH = 500

/** Sweeps visit each organization in its own row-level-security scope. */
async function forEachOrg(db: Db, fn: (tx: Tx, orgId: string) => Promise<number>): Promise<number> {
  const orgs = await db.select({ id: organization.id }).from(organization)
  let total = 0
  for (const org of orgs) total += await withOrg(db, org.id, (tx) => fn(tx, org.id))
  return total
}

/** Re-drives verification for payments still pending after the retry window (missed results, Daraja errors). */
export async function sweepUnverified(deps: WorkerDeps): Promise<number> {
  const cutoff = new Date(deps.now().getTime() - deps.policy.retryAfterMs)
  const queued = await forEachOrg(deps.db, async (tx, orgId) => {
    const rows = await tx
      .select({ id: mpesaTransaction.id })
      .from(mpesaTransaction)
      .where(
        and(
          eq(mpesaTransaction.status, 'pending_verification'),
          lt(mpesaTransaction.verificationAttempts, deps.policy.maxAttempts),
          lt(mpesaTransaction.createdAt, cutoff),
          or(isNull(mpesaTransaction.lastVerificationAt), lt(mpesaTransaction.lastVerificationAt, cutoff)),
        ),
      )
      .limit(BATCH)
    for (const row of rows) {
      await enqueueJob(tx, 'verify_transaction', { orgId, transactionId: row.id }, { jobKey: `verify:${row.id}` })
    }
    return rows.length
  })
  deps.logger.info({ queued }, 'unverified sweep')
  return queued
}

/** Pushes still open without a callback: query them (missed-callback recovery for M-Pesa Express). */
export async function sweepStkRequests(deps: WorkerDeps): Promise<number> {
  const now = deps.now().getTime()
  const cutoff = new Date(now - deps.policy.stkQueryAfterMs)
  const oldest = new Date(now - deps.policy.pullMaxLookbackMs)
  const queued = await forEachOrg(deps.db, async (tx, orgId) => {
    const rows = await tx
      .select({ id: stkRequest.id })
      .from(stkRequest)
      .where(
        and(
          inArray(stkRequest.status, ['initiated', 'pending', 'unknown']),
          isNotNull(stkRequest.checkoutRequestId),
          lt(stkRequest.createdAt, cutoff),
          gt(stkRequest.createdAt, oldest),
          lt(stkRequest.queryAttempts, deps.policy.stkMaxQueries),
          or(isNull(stkRequest.lastQueriedAt), lt(stkRequest.lastQueriedAt, cutoff)),
        ),
      )
      .limit(BATCH)
    for (const row of rows) {
      await enqueueJob(tx, 'check_stk_request', { orgId, stkRequestId: row.id }, { jobKey: `stk:${row.id}` })
    }
    return rows.length
  })
  deps.logger.info({ queued }, 'STK request sweep')
  return queued
}

async function sweepShortcodes(
  deps: WorkerDeps,
  flag: typeof shortcode.pullEnabled | typeof shortcode.initiatorEnabled,
  job: 'pull_transactions' | 'request_balance',
): Promise<number> {
  return forEachOrg(deps.db, async (tx, orgId) => {
    const rows = await tx
      .select({ id: shortcode.id })
      .from(shortcode)
      .where(and(eq(flag, true), eq(shortcode.environment, deps.environment)))
    for (const row of rows) {
      await enqueueJob(tx, job, { orgId, shortcodeId: row.id }, { jobKey: `${job}:${row.id}` })
    }
    return rows.length
  })
}

/** Pull Transactions for every shortcode registered for it: recovers C2B payments whose callback was missed. */
export const sweepPull = (deps: WorkerDeps) => sweepShortcodes(deps, shortcode.pullEnabled, 'pull_transactions')

/** End-of-day Account Balance for every shortcode our initiator may query. */
export const sweepBalances = (deps: WorkerDeps) => sweepShortcodes(deps, shortcode.initiatorEnabled, 'request_balance')
