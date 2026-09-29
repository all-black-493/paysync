import { schema, type Tx } from '@paysync/db'
import { and, asc, eq, lt, sql } from 'drizzle-orm'
import { z } from 'zod'
import { iso } from '../mappers.js'

const { approval, pendingAction, user } = schema

export type PendingRow = typeof pendingAction.$inferSelect

/** A pending action as the API shows it: with requester and approver names. */
export async function toPendingAction(tx: Tx, row: PendingRow) {
  const decisions = await tx
    .select({ approverId: approval.approverUserId, name: user.name, decision: approval.decision, note: approval.note, at: approval.createdAt })
    .from(approval)
    .leftJoin(user, eq(user.id, approval.approverUserId))
    .where(eq(approval.pendingActionId, row.id))
    .orderBy(asc(approval.createdAt))
  const [requester] = await tx.select({ name: user.name }).from(user).where(eq(user.id, row.requestedBy))
  return {
    id: row.id,
    procedure: row.procedure,
    risk: z.enum(['read', 'write', 'destructive']).parse(row.risk),
    money: row.money,
    summary: row.summary,
    reasons: z.array(z.string()).parse(row.reasons),
    input: row.input,
    preview: row.preview,
    requestedBy: { id: row.requestedBy, name: requester?.name ?? null },
    surface: row.surface,
    status: row.status,
    approvalsRequired: row.approvalsRequired,
    approvals: decisions.map((d) => ({ approverId: d.approverId, approverName: d.name ?? null, decision: d.decision, note: d.note, at: iso(d.at) })),
    result: row.result,
    error: row.error,
    createdAt: iso(row.createdAt),
    expiresAt: iso(row.expiresAt),
    decidedAt: row.decidedAt ? iso(row.decidedAt) : null,
    version: row.version,
  }
}

/** Requests past their expiry are marked expired whenever the queue is read or decided on. */
export async function expireOld(tx: Tx): Promise<void> {
  await tx
    .update(pendingAction)
    .set({ status: 'expired', decidedAt: sql`now()`, version: sql`${pendingAction.version} + 1` })
    .where(and(eq(pendingAction.status, 'pending'), lt(pendingAction.expiresAt, sql`now()`)))
}
