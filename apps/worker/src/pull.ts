import { normalizePullRecord, type NormalizedPayment, type PullRecord } from '@paysync/daraja'
import { schema, withOrg, type JobPayload } from '@paysync/db'
import { insertEvent, insertTransaction, storeUnrouted } from '@paysync/ingest'
import { and, eq, sql } from 'drizzle-orm'
import type { WorkerDeps } from './deps.js'
import { failVerification, markVerified } from './verification.js'

const { mpesaTransaction, pullCursor, shortcode } = schema

export type PullRecordOutcome = 'created' | 'verified' | 'failed' | 'unchanged' | 'invalid'

interface Target {
  readonly orgId: string
  readonly shortcodeId: string
  readonly code: string
}

/**
 * One Pull Transactions record: fetched by us from Safaricom, so it both
 * recovers a missed callback and verifies a pending one. Safe to repeat and to
 * race a late callback for the same receipt.
 */
export async function ingestPullRecord(deps: WorkerDeps, target: Target, record: PullRecord): Promise<PullRecordOutcome> {
  let payment: NormalizedPayment
  try {
    payment = normalizePullRecord(record, target.code)
  } catch (error) {
    deps.logger.warn({ err: error, shortcodeId: target.shortcodeId }, 'unusable Pull Transactions record')
    await storeUnrouted(deps, 'pull', `${target.code}:${record.transactionId}`, 'invalid_payload', record)
    return 'invalid'
  }

  return withOrg(deps.db, target.orgId, async (tx) => {
    const eventId = await insertEvent(tx, deps, {
      orgId: target.orgId,
      shortcodeId: target.shortcodeId,
      source: 'pull',
      externalId: payment.receiptNumber,
      payload: record,
    })
    if (eventId) {
      const created = await insertTransaction(tx, deps, {
        orgId: target.orgId,
        shortcodeId: target.shortcodeId,
        source: 'pull',
        inboundEventId: eventId,
        payment,
      })
      if (created) {
        await markVerified(tx, created, 'pull')
        return 'created'
      }
    }
    const [existing] = await tx
      .select({ id: mpesaTransaction.id, amount: mpesaTransaction.amount, status: mpesaTransaction.status })
      .from(mpesaTransaction)
      .where(and(eq(mpesaTransaction.shortcodeId, target.shortcodeId), eq(mpesaTransaction.receiptNumber, payment.receiptNumber)))
    if (existing?.status !== 'pending_verification') return 'unchanged'
    if (existing.amount === payment.amountMinor) {
      return (await markVerified(tx, existing.id, 'pull')) ? 'verified' : 'unchanged'
    }
    await failVerification(tx, existing.id, 'Pull Transactions reports a different amount', {
      method: 'pull',
      pulledMinor: payment.amountMinor.toString(),
      recordedMinor: existing.amount.toString(),
    })
    return 'failed'
  })
}

/** Reads the window since the last pull (with overlap) page by page, then advances the cursor. */
export async function pullTransactions(deps: WorkerDeps, { orgId, shortcodeId }: JobPayload<'pull_transactions'>) {
  const target = await withOrg(deps.db, orgId, async (tx) => {
    const [row] = await tx
      .select({ code: shortcode.code, pullEnabled: shortcode.pullEnabled, pulledUntil: pullCursor.pulledUntil })
      .from(shortcode)
      .leftJoin(pullCursor, eq(pullCursor.shortcodeId, shortcode.id))
      .where(eq(shortcode.id, shortcodeId))
    return row?.pullEnabled ? row : null
  })
  if (!target) return null

  const { policy } = deps
  const now = deps.now().getTime()
  const oldest = now - policy.pullMaxLookbackMs
  const from = target.pulledUntil ? target.pulledUntil.getTime() - policy.pullOverlapMs : now - policy.pullInitialLookbackMs
  const start = new Date(Math.max(from, oldest))
  const end = new Date(now)

  const counts: Record<PullRecordOutcome, number> = { created: 0, verified: 0, failed: 0, unchanged: 0, invalid: 0 }
  let offset = 0
  for (let page = 0; page < policy.pullMaxPages; page++) {
    const response = await deps.daraja.pullTransactions({ shortcode: target.code, start, end, offset })
    const records = response.Response.flat()
    if (response.ResponseCode === '1001' || records.length === 0) break
    for (const record of records) {
      counts[await ingestPullRecord(deps, { orgId, shortcodeId, code: target.code }, record)]++
    }
    offset += records.length
  }

  await withOrg(deps.db, orgId, (tx) =>
    tx
      .insert(pullCursor)
      .values({ shortcodeId, orgId, pulledUntil: end })
      .onConflictDoUpdate({ target: pullCursor.shortcodeId, set: { pulledUntil: end, updatedAt: sql`now()` } }),
  )
  deps.logger.info({ shortcodeId, start, end, ...counts }, 'pulled transactions')
  return counts
}
