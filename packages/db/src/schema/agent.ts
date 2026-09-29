import { sql } from 'drizzle-orm'
import { boolean, check, index, integer, jsonb, pgSchema, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { createdAt, id, idOrgUnique, oneOf, orgId, sameOrg, updatedAt, version } from './columns.js'

export const agent = pgSchema('agent')

export const idempotencyRecord = agent.table(
  'idempotency_record',
  {
    id: id(),
    orgId: orgId(),
    key: text().notNull(),
    action: text().notNull(),
    requestHash: text().notNull(),
    response: jsonb().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.orgId, t.key),
    check('idempotency_record_key_length', sql`char_length(${t.key}) BETWEEN 8 AND 200`),
  ],
)

export const PENDING_ACTION_STATUSES = ['pending', 'rejected', 'executed', 'failed', 'expired'] as const
export const APPROVAL_DECISIONS = ['approve', 'reject'] as const

/**
 * A guarded request waiting for human approval. It keeps the exact input and
 * idempotency key so approval runs the same request once.
 */
export const pendingAction = agent.table(
  'pending_action',
  {
    id: id(),
    orgId: orgId(),
    procedure: text().notNull(),
    risk: text().notNull(),
    money: boolean().notNull().default(false),
    input: jsonb().notNull(),
    summary: text().notNull(),
    /** The dry-run result at request time. */
    preview: jsonb(),
    reasons: jsonb().notNull().default([]),
    requestedBy: text().notNull(),
    requesterKind: text().notNull(),
    surface: text().notNull(),
    agentSessionId: text(),
    idempotencyKey: text().notNull(),
    approvalsRequired: integer().notNull(),
    status: text({ enum: PENDING_ACTION_STATUSES }).notNull().default('pending'),
    result: jsonb(),
    error: text(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    decidedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    unique().on(t.orgId, t.idempotencyKey),
    idOrgUnique('pending_action_id_org_unique', t),
    index().on(t.orgId, t.status, t.createdAt),
    check('pending_action_status', oneOf('status', PENDING_ACTION_STATUSES)),
    check('pending_action_approvals_required', sql`${t.approvalsRequired} BETWEEN 1 AND 2`),
    check('pending_action_summary_length', sql`char_length(${t.summary}) BETWEEN 1 AND 500`),
  ],
)

/** One decision per approver per action. Append-only; the requester can never be an approver. */
export const approval = agent.table(
  'approval',
  {
    id: id(),
    orgId: orgId(),
    pendingActionId: uuid().notNull(),
    approverUserId: text().notNull(),
    decision: text({ enum: APPROVAL_DECISIONS }).notNull(),
    note: text(),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.pendingActionId, t.approverUserId),
    sameOrg('approval_pending_action_fk', { column: t.pendingActionId, orgId: t.orgId }, pendingAction),
    check('approval_decision', oneOf('decision', APPROVAL_DECISIONS)),
    check('approval_note_length', sql`${t.note} IS NULL OR char_length(${t.note}) <= 1000`),
  ],
)
