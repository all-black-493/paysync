import { sql } from 'drizzle-orm'
import { check, jsonb, pgSchema, text, unique } from 'drizzle-orm/pg-core'
import { createdAt, id, orgId } from './columns.js'

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
