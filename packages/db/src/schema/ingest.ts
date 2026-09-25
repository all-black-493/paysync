import { sql } from 'drizzle-orm'
import { check, index, jsonb, pgSchema, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { id, idOrgUnique, oneOf, orgId } from './columns.js'

export const ingest = pgSchema('ingest')

export const INBOUND_SOURCES = [
  'c2b_validation',
  'c2b_confirmation',
  'stk_callback',
  'transaction_status_result',
  'reversal_result',
  'account_balance_result',
  'queue_timeout',
  'pull',
  'statement',
] as const

export const inboundEvent = ingest.table(
  'inbound_event',
  {
    id: id(),
    orgId: orgId(),
    shortcodeId: uuid().notNull(),
    source: text({ enum: INBOUND_SOURCES }).notNull(),
    externalId: text().notNull(),
    /** Stored verbatim before any processing. */
    payload: jsonb().notNull(),
    receivedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.source, t.externalId),
    idOrgUnique('inbound_event_id_org_unique', t),
    index().on(t.orgId, t.receivedAt),
    check('inbound_event_source', oneOf('source', INBOUND_SOURCES)),
    check('inbound_event_external_id_length', sql`char_length(${t.externalId}) BETWEEN 1 AND 128`),
  ],
)
