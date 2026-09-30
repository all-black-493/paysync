import { schema, withOrg, type Tx } from '@paysync/db'
import type { GuardPolicy } from '@paysync/guard'
import { and, count, eq, gt, sql } from 'drizzle-orm'
import { redact } from '../mutate.js'
import type { GuardContext } from './types.js'

const { auditEvent } = schema

/** A guard decision that did not run the action (block, budget, waiting for approval). */
export async function auditDecision(
  tx: Tx,
  context: GuardContext,
  action: string,
  input: Record<string, unknown>,
  decision: string,
  outcome: string,
  details: Record<string, unknown>,
): Promise<void> {
  await tx.insert(auditEvent).values({
    orgId: context.caller.orgId,
    surface: context.surface,
    userId: context.caller.actorId,
    agentSessionId: context.caller.agentSessionId,
    mcpClientId: context.caller.mcpClientId,
    action,
    input: redact(input),
    decision,
    outcome,
    details: { sessionId: context.caller.session?.id ?? null, ...details },
  })
}

/** Writes are audited, so the audit log doubles as the per-caller rate counter across replicas. */
export async function tooManyWrites(context: GuardContext, policy: GuardPolicy): Promise<boolean> {
  const [row] = await withOrg(context.db, context.caller.orgId, (tx) =>
    tx
      .select({ n: count() })
      .from(auditEvent)
      .where(and(eq(auditEvent.userId, context.caller.actorId), gt(auditEvent.occurredAt, sql`now() - interval '1 minute'`))),
  )
  return (row?.n ?? 0) >= policy.writesPerMinute
}
