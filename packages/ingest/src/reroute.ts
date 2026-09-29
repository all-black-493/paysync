import { schema } from '@paysync/db'
import { and, eq } from 'drizzle-orm'
import { ingestC2B, ingestStkCallback, type IngestDeps, type IngestResult, type Source } from './ingest.js'
import { ingestDarajaResult } from './results.js'
import { unsealPayload } from './sealing.js'

const { unroutedEvent } = schema

/**
 * Retries routing a delivery that arrived before the request it answers was
 * recorded (an STK callback before its CheckoutRequestID, a result before its
 * ConversationID). The unrouted copy stays as history.
 */
export async function rerouteUnrouted(deps: IngestDeps, source: Source, externalId: string): Promise<IngestResult | null> {
  const [row] = await deps.db
    .select()
    .from(unroutedEvent)
    .where(and(eq(unroutedEvent.source, source), eq(unroutedEvent.externalId, externalId)))
  if (!row || row.reason === 'malformed_json' || row.reason === 'invalid_payload') return null
  const body = unsealPayload(row.payload, deps.pii)
  switch (row.source) {
    case 'stk_callback':
      return ingestStkCallback(deps, body)
    case 'c2b_confirmation':
    case 'c2b_validation':
      return ingestC2B(deps, row.source, body)
    case 'transaction_status_result':
      return ingestDarajaResult(deps, 'result', 'transaction_status', body)
    case 'account_balance_result':
      return ingestDarajaResult(deps, 'result', 'account_balance', body)
    case 'queue_timeout':
      return ingestDarajaResult(deps, 'timeout', 'transaction_status', body)
    case 'reversal_result':
      return ingestDarajaResult(deps, 'result', 'reversal', body)
    case 'pull':
    case 'statement':
      return null
  }
}
