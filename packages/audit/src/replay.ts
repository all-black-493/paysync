import { schema, withOrg, type Db } from '@paysync/db'
import { and, asc, eq, gte, or, sql, type SQL } from 'drizzle-orm'

const { auditEvent } = schema

export interface ReplayFilter {
  /** A web session id or an agent session id. */
  readonly sessionId?: string
  readonly userId?: string
  readonly since?: Date
  readonly limit?: number
}

export interface TimelineEntry {
  readonly at: Date
  readonly surface: string
  readonly userId: string | null
  readonly action: string
  readonly decision: string | null
  readonly outcome: string
  readonly details: unknown
}

/** The audit trail for a session or a person, oldest first (AGENTS.md §8.5). */
export async function replay(db: Db, orgId: string, filter: ReplayFilter): Promise<TimelineEntry[]> {
  const conditions: SQL[] = []
  if (filter.sessionId) {
    const bySession = or(eq(auditEvent.agentSessionId, filter.sessionId), sql`${auditEvent.details}->>'sessionId' = ${filter.sessionId}`)
    if (bySession) conditions.push(bySession)
  }
  if (filter.userId) conditions.push(eq(auditEvent.userId, filter.userId))
  if (filter.since) conditions.push(gte(auditEvent.occurredAt, filter.since))
  const rows = await withOrg(db, orgId, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(...conditions))
      .orderBy(asc(auditEvent.occurredAt))
      .limit(filter.limit ?? 500),
  )
  return rows.map((r) => ({
    at: r.occurredAt,
    surface: r.surface,
    userId: r.userId,
    action: r.action,
    decision: r.decision,
    outcome: r.outcome,
    details: r.details,
  }))
}

/** One readable line per event, for demos and incident review. */
export function formatTimeline(entries: readonly TimelineEntry[]): string {
  return entries
    .map((e) => {
      const decision = e.decision ? ` [${e.decision}]` : ''
      const reasons = typeof e.details === 'object' && e.details !== null && 'reasons' in e.details && Array.isArray(e.details.reasons) && e.details.reasons.length > 0
        ? ` — ${e.details.reasons.join('; ')}`
        : ''
      return `${e.at.toISOString()}  ${e.surface.padEnd(6)} ${(e.userId ?? '-').padEnd(34)} ${e.action}${decision} → ${e.outcome}${reasons}`
    })
    .join('\n')
}
