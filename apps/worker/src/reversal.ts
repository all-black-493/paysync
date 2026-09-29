import { raiseException, schema, withOrg, type JobPayload, type Tx } from '@paysync/db'
import { rerouteUnrouted } from '@paysync/ingest'
import { and, eq } from 'drizzle-orm'
import type { WorkerDeps } from './deps.js'

const { darajaRequest, mpesaTransaction, shortcode } = schema

type RequestRow = typeof darajaRequest.$inferSelect

async function fail(tx: Tx, request: RequestRow, receipt: string, reason: string) {
  await tx.update(darajaRequest).set({ status: 'failed', resultDesc: reason.slice(0, 500), version: request.version + 1 }).where(eq(darajaRequest.id, request.id))
  await raiseException(tx, {
    orgId: request.orgId,
    kind: 'reversal_failed',
    priority: 'high',
    summary: `Reversal of payment ${receipt}: ${reason}`,
    transactionId: request.transactionId,
    details: { darajaRequestId: request.id },
    dedupeKey: `reversal_failed:${request.id}`,
  })
}

/**
 * execute_reversal: sends an approved reversal to Daraja exactly once (the job
 * has one attempt). The answer arrives on the Result URL; a failed call has an
 * unknown outcome and goes to a person instead of being retried (§5.2).
 */
export async function executeReversal(deps: WorkerDeps, { orgId, darajaRequestId }: JobPayload<'execute_reversal'>): Promise<void> {
  const claimed = await withOrg(deps.db, orgId, async (tx) => {
    const [row] = await tx
      .select({ request: darajaRequest, receipt: mpesaTransaction.receiptNumber, amount: mpesaTransaction.amount, code: shortcode.code, initiatorEnabled: shortcode.initiatorEnabled })
      .from(darajaRequest)
      .innerJoin(mpesaTransaction, eq(mpesaTransaction.id, darajaRequest.transactionId))
      .innerJoin(shortcode, eq(shortcode.id, darajaRequest.shortcodeId))
      .where(and(eq(darajaRequest.id, darajaRequestId), eq(darajaRequest.kind, 'reversal'), eq(darajaRequest.status, 'initiated')))
    if (!row) return null
    if (!row.initiatorEnabled || !deps.daraja.hasInitiator || !deps.resultUrls) {
      await fail(tx, row.request, row.receipt, 'no initiator or public result URL is configured for this shortcode; nothing was sent')
      return null
    }
    return row
  })
  if (!claimed || !deps.resultUrls) return

  let response
  try {
    response = await deps.daraja.reversal({
      shortcode: claimed.code,
      receiptNumber: claimed.receipt,
      amountMinor: claimed.amount,
      remarks: 'Approved reversal',
      ...deps.resultUrls('reversal'),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'request failed'
    await withOrg(deps.db, orgId, (tx) =>
      fail(tx, claimed.request, claimed.receipt, `the Daraja call failed (${message}); the outcome is unknown, check M-Pesa before retrying`),
    )
    return
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
        version: claimed.request.version + 1,
      })
      .where(eq(darajaRequest.id, claimed.request.id)),
  )
  deps.logger.info({ darajaRequestId, conversationId: response.ConversationID }, 'reversal sent')
  await rerouteUnrouted(deps, 'reversal_result', response.ConversationID)
}
