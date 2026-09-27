import { raiseException, schema, withOrg, type JobPayload } from '@paysync/db'
import { rerouteUnrouted } from '@paysync/ingest'
import { and, eq, inArray } from 'drizzle-orm'
import type { WorkerDeps } from './deps.js'

const { mpesaTransaction, shortcode, stkRequest } = schema

const OPEN = ['initiated', 'pending', 'unknown'] as const

/**
 * A push whose callback has not arrived. STK Query gives the outcome but no
 * receipt number, so a paid push without its callback becomes an exception
 * until Pull Transactions or a statement supplies the receipt.
 */
export async function checkStkRequest(deps: WorkerDeps, { orgId, stkRequestId }: JobPayload<'check_stk_request'>): Promise<void> {
  const claimed = await withOrg(deps.db, orgId, async (tx) => {
    const [row] = await tx
      .select({ request: stkRequest, code: shortcode.code })
      .from(stkRequest)
      .innerJoin(shortcode, eq(shortcode.id, stkRequest.shortcodeId))
      .where(and(eq(stkRequest.id, stkRequestId), inArray(stkRequest.status, [...OPEN])))
    if (!row?.request.checkoutRequestId) return null
    await tx
      .update(stkRequest)
      .set({ queryAttempts: row.request.queryAttempts + 1, lastQueriedAt: deps.now(), version: row.request.version + 1 })
      .where(eq(stkRequest.id, stkRequestId))
    return { ...row, checkoutRequestId: row.request.checkoutRequestId, version: row.request.version + 1 }
  })
  if (!claimed) return

  // The callback may have arrived before the CheckoutRequestID was saved.
  const rerouted = await rerouteUnrouted(deps, 'stk_callback', claimed.checkoutRequestId)
  if (rerouted?.routed) return

  const query = await deps.daraja.stkQuery(claimed.code, claimed.checkoutRequestId)
  deps.logger.info({ stkRequestId, outcome: query.outcome, resultCode: query.resultCode }, 'STK request checked')
  if (query.outcome === 'pending' || query.outcome === 'unknown') return

  await withOrg(deps.db, orgId, async (tx) => {
    const [request] = await tx.select().from(stkRequest).where(eq(stkRequest.id, stkRequestId)).for('update')
    if (!request || !(OPEN as readonly string[]).includes(request.status)) return
    await tx
      .update(stkRequest)
      .set({ status: query.outcome, resultCode: query.resultCode, resultDesc: query.resultDesc, version: request.version + 1 })
      .where(eq(stkRequest.id, stkRequestId))
    if (query.outcome !== 'succeeded') return
    const [transaction] = await tx
      .select({ id: mpesaTransaction.id })
      .from(mpesaTransaction)
      .where(eq(mpesaTransaction.stkRequestId, stkRequestId))
    if (transaction) return
    await raiseException(tx, {
      orgId,
      kind: 'missing_callback',
      priority: 'high',
      summary: `An M-Pesa Express payment for ${request.accountReference} succeeded but its callback never arrived`,
      details: {
        checkoutRequestId: claimed.checkoutRequestId,
        requestedMinor: request.amount.toString(),
        note: 'The receipt number arrives with Pull Transactions or the statement; the payment is not in the ledger yet.',
      },
      dedupeKey: `missing_callback:${stkRequestId}`,
    })
  })
}
