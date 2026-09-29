import { DarajaResult, normalizeAccountBalanceResult, normalizeReversalResult, normalizeTransactionStatusResult } from '@paysync/daraja'
import { schema, withOrg, type JobPayload } from '@paysync/db'
import { unsealPayload } from '@paysync/ingest'
import { eq, or } from 'drizzle-orm'
import type { WorkerDeps } from '../deps.js'
import { applyAccountBalance } from './account-balance.js'
import { applyReversal, applyReversalTimeout } from './reversal.js'
import { applyTransactionStatus } from './transaction-status.js'

const { darajaRequest, inboundEvent } = schema

/** apply_daraja_result: settles the request a Result/QueueTimeout body answers, then applies it by kind. */
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
      const timedOut = event.source === 'queue_timeout'
      await tx
        .update(darajaRequest)
        .set({ status: timedOut ? 'timed_out' : 'failed', version: request.version + 1 })
        .where(eq(darajaRequest.id, request.id))
      if (request.kind === 'reversal') await applyReversalTimeout(tx, request)
      return
    }

    const status = ids.data.Result.ResultCode === '0' ? 'completed' : 'failed'
    await tx
      .update(darajaRequest)
      .set({ status, resultCode: ids.data.Result.ResultCode, resultDesc: ids.data.Result.ResultDesc.slice(0, 500), version: request.version + 1 })
      .where(eq(darajaRequest.id, request.id))

    switch (request.kind) {
      case 'transaction_status':
        await applyTransactionStatus(deps, tx, request, normalizeTransactionStatusResult(ids.data))
        return
      case 'account_balance': {
        const result = normalizeAccountBalanceResult(ids.data)
        if (result.succeeded) await applyAccountBalance(deps, tx, request, result.accounts, result.completedAt ?? event.receivedAt)
        return
      }
      case 'reversal':
        await applyReversal(deps, tx, request, normalizeReversalResult(ids.data))
        return
    }
  })
}
