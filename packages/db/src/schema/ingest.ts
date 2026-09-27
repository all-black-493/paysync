import { sql } from 'drizzle-orm'
import { check, index, jsonb, pgSchema, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { bytea, createdAt, money, sameOrg, updatedAt, version } from './columns.js'
import { shortcode } from './core.js'
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

export const STK_REQUEST_STATUSES = ['initiated', 'pending', 'succeeded', 'failed', 'cancelled', 'unknown'] as const

/** A push we initiated; recorded before calling Daraja so its callback can be routed. */
export const stkRequest = ingest.table(
  'stk_request',
  {
    id: id(),
    orgId: orgId(),
    shortcodeId: uuid().notNull(),
    checkoutRequestId: text().unique(),
    merchantRequestId: text(),
    accountReference: text().notNull(),
    amount: money(),
    phoneCiphertext: bytea(),
    status: text({ enum: STK_REQUEST_STATUSES }).notNull().default('initiated'),
    resultCode: text(),
    resultDesc: text(),
    createdBy: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    idOrgUnique('stk_request_id_org_unique', t),
    index().on(t.orgId, t.createdAt),
    sameOrg('stk_request_shortcode_fk', { column: t.shortcodeId, orgId: t.orgId }, shortcode),
    check('stk_request_status', oneOf('status', STK_REQUEST_STATUSES)),
    check('stk_request_amount_positive', sql`${t.amount} > 0`),
    check('stk_request_account_reference_length', sql`char_length(${t.accountReference}) BETWEEN 1 AND 12`),
  ],
)

export const UNROUTED_REASONS = ['unknown_shortcode', 'unknown_checkout', 'invalid_payload', 'malformed_json'] as const

/** Callbacks we could not attribute to an organization. Kept verbatim; never dropped. */
export const unroutedEvent = ingest.table(
  'unrouted_event',
  {
    id: id(),
    source: text({ enum: INBOUND_SOURCES }).notNull(),
    externalId: text().notNull(),
    reason: text({ enum: UNROUTED_REASONS }).notNull(),
    payload: jsonb().notNull(),
    receivedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.source, t.externalId),
    check('unrouted_event_source', oneOf('source', INBOUND_SOURCES)),
    check('unrouted_event_reason', oneOf('reason', UNROUTED_REASONS)),
  ],
)

/** One shared Daraja access token per credential set (encrypted). */
export const darajaToken = ingest.table('daraja_token', {
  credentialId: text().primaryKey(),
  ciphertext: bytea().notNull(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  updatedAt: updatedAt(),
})
