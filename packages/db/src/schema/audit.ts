import { check, index, jsonb, pgSchema, text, timestamp } from 'drizzle-orm/pg-core'
import { id, oneOf, orgId } from './columns.js'

export const audit = pgSchema('audit')

export const SURFACES = ['web', 'rest', 'ai-sdk', 'mcp', 'system'] as const

export const auditEvent = audit.table(
  'event',
  {
    id: id(),
    orgId: orgId(),
    occurredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    surface: text({ enum: SURFACES }).notNull(),
    userId: text(),
    agentSessionId: text(),
    mcpClientId: text(),
    action: text().notNull(),
    /** Redacted before insert. */
    input: jsonb(),
    decision: text(),
    outcome: text().notNull(),
    details: jsonb(),
    traceId: text(),
  },
  (t) => [index().on(t.orgId, t.occurredAt), check('event_surface', oneOf('surface', SURFACES))],
)
