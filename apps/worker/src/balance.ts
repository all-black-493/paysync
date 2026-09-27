import { schema, withOrg, type JobPayload } from '@paysync/db'
import { rerouteUnrouted } from '@paysync/ingest'
import { eq } from 'drizzle-orm'
import type { WorkerDeps } from './deps.js'

const { darajaRequest, shortcode } = schema

/** Asks for the shortcode's balances; apply_daraja_result compares them with the ledger when they arrive. */
export async function requestBalance(deps: WorkerDeps, { orgId, shortcodeId }: JobPayload<'request_balance'>): Promise<void> {
  if (!deps.daraja.hasInitiator || !deps.resultUrls) {
    deps.logger.warn({ shortcodeId }, 'account balance check skipped: no initiator or no public callback URL')
    return
  }
  const urls = deps.resultUrls('balance')
  const request = await withOrg(deps.db, orgId, async (tx) => {
    const [target] = await tx.select().from(shortcode).where(eq(shortcode.id, shortcodeId))
    if (!target?.initiatorEnabled) return null
    const [created] = await tx.insert(darajaRequest).values({ orgId, shortcodeId, kind: 'account_balance' }).returning()
    return created ? { ...created, code: target.code } : null
  })
  if (!request) return

  let response
  try {
    response = await deps.daraja.accountBalance({ shortcode: request.code, ...urls })
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
  await rerouteUnrouted(deps, 'account_balance_result', response.ConversationID)
}
