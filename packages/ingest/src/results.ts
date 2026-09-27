import { ConversationIds } from '@paysync/daraja'
import { enqueueJob, withOrg } from '@paysync/db'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { bodyHash, insertEvent, storeUnrouted, type IngestDeps, type IngestResult } from './ingest.js'

export type ResultKind = 'transaction_status' | 'account_balance'

const Route = z.object({ daraja_request_id: z.string(), org_id: z.string(), shortcode_id: z.string(), kind: z.string() })

const SOURCES = {
  result: { transaction_status: 'transaction_status_result', account_balance: 'account_balance_result' },
  timeout: { transaction_status: 'queue_timeout', account_balance: 'queue_timeout' },
} as const

/**
 * Result and QueueTimeout URL bodies for requests we sent. Stored first,
 * then applied by the worker (apply_daraja_result), enqueued in the same
 * transaction.
 */
export async function ingestDarajaResult(
  deps: IngestDeps,
  delivery: 'result' | 'timeout',
  kind: ResultKind,
  body: unknown,
): Promise<IngestResult> {
  const source = SOURCES[delivery][kind]
  const parsed = ConversationIds.safeParse(body)
  if (!parsed.success) return storeUnrouted(deps, source, bodyHash(JSON.stringify(body)), 'invalid_payload', body)
  const ids = 'Result' in parsed.data ? parsed.data.Result : parsed.data

  const { rows } = await deps.db.execute(
    sql`SELECT * FROM ingest.route_daraja_conversation(${ids.OriginatorConversationID}, ${ids.ConversationID})`,
  )
  const target = rows.length === 0 ? undefined : Route.parse(rows[0])
  if (!target) return storeUnrouted(deps, source, ids.ConversationID, 'unknown_conversation', body)

  return withOrg(deps.db, target.org_id, async (tx) => {
    const eventId = await insertEvent(tx, deps, {
      orgId: target.org_id,
      shortcodeId: target.shortcode_id,
      source,
      externalId: ids.ConversationID,
      payload: body,
    })
    if (!eventId) return { routed: true, duplicate: true, createdReceipt: null }
    await enqueueJob(tx, 'apply_daraja_result', { orgId: target.org_id, inboundEventId: eventId })
    return { routed: true, duplicate: false, createdReceipt: null }
  })
}
