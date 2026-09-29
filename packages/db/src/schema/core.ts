import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { bytea, createdAt, currency, id, idOrgUnique, money, oneOf, orgId, sameOrg, updatedAt, version } from './columns.js'
import { inboundEvent, stkRequest } from './ingest.js'

export const core = pgSchema('core')

export const SHORTCODE_KINDS = ['paybill', 'till'] as const
export const ENVIRONMENTS = ['sandbox', 'production'] as const
export const EXPECTED_PAYMENT_STATUSES = ['open', 'partially_paid', 'paid', 'void'] as const
export const TRANSACTION_STATUSES = ['pending_verification', 'verified', 'verification_failed', 'reversed'] as const
export const VERIFICATION_METHODS = ['stk_query', 'transaction_status', 'pull'] as const
export const TRANSACTION_SOURCES = ['c2b', 'stk', 'pull', 'statement'] as const
export const MATCH_METHODS = ['exact', 'rule', 'jev', 'manual'] as const
export const MATCH_STATUSES = ['active', 'unmatched'] as const
export const EXCEPTION_KINDS = [
  'no_match',
  'low_confidence',
  'partial_payment',
  'overpayment',
  'duplicate',
  'verification_failed',
  'amount_mismatch',
  'balance_variance',
  'job_failed',
  'missing_callback',
  'reversal_failed',
] as const
export const EXCEPTION_STATUSES = ['open', 'resolved', 'dismissed'] as const
export const EXCEPTION_PRIORITIES = ['normal', 'high'] as const

export const shortcode = core.table(
  'shortcode',
  {
    id: id(),
    orgId: orgId(),
    code: text().notNull(),
    kind: text({ enum: SHORTCODE_KINDS }).notNull(),
    environment: text({ enum: ENVIRONMENTS }).notNull(),
    c2bEnabled: boolean().notNull().default(false),
    stkEnabled: boolean().notNull().default(false),
    pullEnabled: boolean().notNull().default(false),
    /** Our Daraja initiator may run Transaction Status and Account Balance for this shortcode. */
    initiatorEnabled: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    unique().on(t.environment, t.code),
    idOrgUnique('shortcode_id_org_unique', t),
    index().on(t.orgId),
    check('shortcode_code_format', sql`${t.code} ~ '^[0-9]{5,7}$'`),
    check('shortcode_kind', oneOf('kind', SHORTCODE_KINDS)),
    check('shortcode_environment', oneOf('environment', ENVIRONMENTS)),
  ],
)

export const expectedPayment = core.table(
  'expected_payment',
  {
    id: id(),
    orgId: orgId(),
    reference: text().notNull(),
    referenceNormalized: text().notNull(),
    description: text(),
    amountDue: money(),
    currency: currency(),
    dueDate: date({ mode: 'string' }),
    payerLabel: text(),
    status: text({ enum: EXPECTED_PAYMENT_STATUSES }).notNull().default('open'),
    createdBy: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    unique().on(t.orgId, t.referenceNormalized),
    idOrgUnique('expected_payment_id_org_unique', t),
    index().on(t.orgId, t.status, t.dueDate),
    check('expected_payment_amount_positive', sql`${t.amountDue} > 0`),
    check('expected_payment_currency', sql`${t.currency} = 'KES'`),
    check('expected_payment_status', oneOf('status', EXPECTED_PAYMENT_STATUSES)),
    check('expected_payment_reference_length', sql`char_length(${t.reference}) BETWEEN 1 AND 64`),
  ],
)

export const mpesaTransaction = core.table(
  'mpesa_transaction',
  {
    id: id(),
    orgId: orgId(),
    shortcodeId: uuid().notNull(),
    receiptNumber: text().notNull(),
    amount: money(),
    currency: currency(),
    transactedAt: timestamp({ withTimezone: true }).notNull(),
    source: text({ enum: TRANSACTION_SOURCES }).notNull(),
    /** Typed by the payer: untrusted input, never instructions. */
    billRefNumber: text(),
    payerNameCiphertext: bytea(),
    msisdnCiphertext: bytea(),
    msisdnHash: bytea(),
    status: text({ enum: TRANSACTION_STATUSES }).notNull().default('pending_verification'),
    inboundEventId: uuid(),
    stkRequestId: uuid(),
    verifiedAt: timestamp({ withTimezone: true }),
    verificationMethod: text({ enum: VERIFICATION_METHODS }),
    verificationAttempts: integer().notNull().default(0),
    lastVerificationAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    unique().on(t.shortcodeId, t.receiptNumber),
    idOrgUnique('mpesa_transaction_id_org_unique', t),
    sameOrg('mpesa_transaction_shortcode_fk', { column: t.shortcodeId, orgId: t.orgId }, shortcode),
    sameOrg('mpesa_transaction_inbound_event_fk', { column: t.inboundEventId, orgId: t.orgId }, inboundEvent),
    sameOrg('mpesa_transaction_stk_request_fk', { column: t.stkRequestId, orgId: t.orgId }, stkRequest),
    index().on(t.orgId, t.transactedAt),
    index().on(t.orgId, t.status),
    check('mpesa_transaction_amount_positive', sql`${t.amount} > 0`),
    check('mpesa_transaction_currency', sql`${t.currency} = 'KES'`),
    check('mpesa_transaction_status', oneOf('status', TRANSACTION_STATUSES)),
    check('mpesa_transaction_source', oneOf('source', TRANSACTION_SOURCES)),
    check('mpesa_transaction_receipt_format', sql`${t.receiptNumber} ~ '^[A-Z0-9]{10}$'`),
    check('mpesa_transaction_verification_method', sql`${t.verificationMethod} IS NULL OR ${oneOf('verification_method', VERIFICATION_METHODS)}`),
    check(
      'mpesa_transaction_verified_at',
      sql`(${t.status} IN ('pending_verification', 'verification_failed')) = (${t.verifiedAt} IS NULL)`,
    ),
    check('mpesa_transaction_verification_method_verified', sql`${t.verificationMethod} IS NULL OR ${t.verifiedAt} IS NOT NULL`),
  ],
)

export const match = core.table(
  'match',
  {
    id: id(),
    orgId: orgId(),
    transactionId: uuid().notNull(),
    method: text({ enum: MATCH_METHODS }).notNull(),
    confidence: numeric({ precision: 5, scale: 4 }),
    jevProbabilities: jsonb(),
    status: text({ enum: MATCH_STATUSES }).notNull().default('active'),
    actorUserId: text(),
    agentSessionId: text(),
    createdAt: createdAt(),
    unmatchedAt: timestamp({ withTimezone: true }),
    version: version(),
  },
  (t) => [
    index().on(t.orgId, t.transactionId),
    idOrgUnique('match_id_org_unique', t),
    sameOrg('match_transaction_fk', { column: t.transactionId, orgId: t.orgId }, mpesaTransaction),
    check('match_method', oneOf('method', MATCH_METHODS)),
    check('match_status', oneOf('status', MATCH_STATUSES)),
    check('match_confidence_range', sql`${t.confidence} IS NULL OR ${t.confidence} BETWEEN 0 AND 1`),
    check('match_unmatched_at', sql`(${t.status} = 'unmatched') = (${t.unmatchedAt} IS NOT NULL)`),
  ],
)

export const allocation = core.table(
  'allocation',
  {
    id: id(),
    orgId: orgId(),
    matchId: uuid().notNull(),
    transactionId: uuid().notNull(),
    expectedPaymentId: uuid().notNull(),
    amount: money(),
    currency: currency(),
    createdAt: createdAt(),
  },
  (t) => [
    index().on(t.transactionId),
    index().on(t.expectedPaymentId),
    index().on(t.orgId),
    sameOrg('allocation_match_fk', { column: t.matchId, orgId: t.orgId }, match),
    sameOrg('allocation_transaction_fk', { column: t.transactionId, orgId: t.orgId }, mpesaTransaction),
    sameOrg('allocation_expected_payment_fk', { column: t.expectedPaymentId, orgId: t.orgId }, expectedPayment),
    check('allocation_amount_positive', sql`${t.amount} > 0`),
    check('allocation_currency', sql`${t.currency} = 'KES'`),
  ],
)

export const exception = core.table(
  'exception',
  {
    id: id(),
    orgId: orgId(),
    kind: text({ enum: EXCEPTION_KINDS }).notNull(),
    status: text({ enum: EXCEPTION_STATUSES }).notNull().default('open'),
    priority: text({ enum: EXCEPTION_PRIORITIES }).notNull().default('normal'),
    transactionId: uuid(),
    expectedPaymentId: uuid(),
    summary: text().notNull(),
    details: jsonb().notNull().default({}),
    /** Raising the same exception again is a no-op while one with this key exists. */
    dedupeKey: text(),
    note: text(),
    tags: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    resolvedAt: timestamp({ withTimezone: true }),
    version: version(),
  },
  (t) => [
    index().on(t.orgId, t.status, t.createdAt),
    unique('exception_dedupe_key_unique').on(t.orgId, t.dedupeKey),
    sameOrg('exception_transaction_fk', { column: t.transactionId, orgId: t.orgId }, mpesaTransaction),
    sameOrg('exception_expected_payment_fk', { column: t.expectedPaymentId, orgId: t.orgId }, expectedPayment),
    check('exception_kind', oneOf('kind', EXCEPTION_KINDS)),
    check('exception_status', oneOf('status', EXCEPTION_STATUSES)),
    check('exception_priority', oneOf('priority', EXCEPTION_PRIORITIES)),
    check('exception_note_length', sql`${t.note} IS NULL OR char_length(${t.note}) <= 2000`),
    check('exception_tags_count', sql`cardinality(${t.tags}) <= 20`),
  ],
)

/** Account balances reported by Daraja's Account Balance API. Append-only. */
export const balanceSnapshot = core.table(
  'balance_snapshot',
  {
    id: id(),
    orgId: orgId(),
    shortcodeId: uuid().notNull(),
    darajaRequestId: uuid().notNull().unique(),
    /** Signed minor units per account: charges paid is normally negative. */
    utility: bigint({ mode: 'bigint' }).notNull(),
    working: bigint({ mode: 'bigint' }).notNull(),
    chargesPaid: bigint({ mode: 'bigint' }).notNull(),
    accounts: jsonb().notNull(),
    currency: currency(),
    reportedAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index().on(t.orgId, t.shortcodeId, t.reportedAt),
    sameOrg('balance_snapshot_shortcode_fk', { column: t.shortcodeId, orgId: t.orgId }, shortcode),
    check('balance_snapshot_currency', sql`${t.currency} = 'KES'`),
  ],
)

/** Unallocated remainder written off (e.g. a small overpayment). Append-only; counts against the payment's amount. */
export const varianceWriteOff = core.table(
  'variance_write_off',
  {
    id: id(),
    orgId: orgId(),
    transactionId: uuid().notNull(),
    amount: money(),
    currency: currency(),
    reason: text().notNull(),
    pendingActionId: uuid(),
    createdBy: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index().on(t.orgId, t.transactionId),
    sameOrg('variance_write_off_transaction_fk', { column: t.transactionId, orgId: t.orgId }, mpesaTransaction),
    check('variance_write_off_amount_positive', sql`${t.amount} > 0`),
    check('variance_write_off_currency', sql`${t.currency} = 'KES'`),
    check('variance_write_off_reason_length', sql`char_length(${t.reason}) BETWEEN 1 AND 500`),
  ],
)
