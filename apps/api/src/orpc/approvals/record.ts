import { schema, type Tx } from '@paysync/db'
import { and, eq, sql } from 'drizzle-orm'
import { executeApproved } from './execute.js'
import type { PendingRow } from './view.js'

const { approval, auditEvent, pendingAction } = schema

/** Why a decision could not be recorded; the handler maps these to typed errors. */
export class DecisionError extends Error {
  readonly code: 'NOT_FOUND' | 'OWN_REQUEST' | 'STALE_STATE' | 'INVALID_STATE'
  readonly data: { currentVersion?: number; status?: string }

  constructor(code: DecisionError['code'], message: string, data: DecisionError['data'] = {}) {
    super(message)
    this.name = 'DecisionError'
    this.code = code
    this.data = data
  }
}

export interface Decision {
  readonly pendingActionId: string
  readonly version: number
  readonly decision: 'approve' | 'reject'
  readonly note: string | null
  readonly approverId: string
  readonly sessionId: string
}

async function auditApprover(tx: Tx, row: PendingRow, decision: Decision, outcome: string, extra: Record<string, unknown> = {}) {
  await tx.insert(auditEvent).values({
    orgId: row.orgId,
    surface: 'web',
    userId: decision.approverId,
    action: 'approvals.decide',
    input: { pendingActionId: row.id, decision: decision.decision },
    decision: decision.decision,
    outcome,
    details: { sessionId: decision.sessionId, procedure: row.procedure, ...extra },
  })
}

/**
 * Records one approver's decision and, when it completes the approvals,
 * executes the request in the same transaction. A retry by the same
 * approver returns the current state.
 */
export async function recordDecision(tx: Tx, decision: Decision): Promise<PendingRow> {
  const [row] = await tx.select().from(pendingAction).where(eq(pendingAction.id, decision.pendingActionId)).for('update')
  if (!row) throw new DecisionError('NOT_FOUND', 'pending action not found')
  if (row.requestedBy === decision.approverId) throw new DecisionError('OWN_REQUEST', 'You cannot decide on your own request.')
  const [mine] = await tx
    .select({ id: approval.id })
    .from(approval)
    .where(and(eq(approval.pendingActionId, row.id), eq(approval.approverUserId, decision.approverId)))
  if (mine) return row
  if (row.version !== decision.version) throw new DecisionError('STALE_STATE', 'the request changed', { currentVersion: row.version })
  if (row.status !== 'pending') throw new DecisionError('INVALID_STATE', `the request is ${row.status}`, { status: row.status })

  await tx.insert(approval).values({
    orgId: row.orgId,
    pendingActionId: row.id,
    approverUserId: decision.approverId,
    decision: decision.decision,
    note: decision.note,
  })
  await auditApprover(tx, row, decision, 'recorded')

  const settle = async (changes: Partial<typeof pendingAction.$inferInsert>) => {
    const [updated] = await tx
      .update(pendingAction)
      .set({ ...changes, version: row.version + 1 })
      .where(eq(pendingAction.id, row.id))
      .returning()
    return updated ?? row
  }

  if (decision.decision === 'reject') return settle({ status: 'rejected', decidedAt: new Date() })
  const approvers = await tx
    .select({ id: approval.approverUserId })
    .from(approval)
    .where(and(eq(approval.pendingActionId, row.id), eq(approval.decision, 'approve')))
  if (approvers.length < row.approvalsRequired) return settle({})

  const executed = await executeApproved(
    tx,
    row,
    approvers.map((a) => a.id),
  )
  return settle({ status: 'executed', result: executed.result, decidedAt: new Date() })
}

/** The approved action could not run: keep the approval and mark the request failed. */
export async function recordFailure(tx: Tx, decision: Decision, message: string): Promise<void> {
  const [row] = await tx.select().from(pendingAction).where(eq(pendingAction.id, decision.pendingActionId)).for('update')
  if (row?.status !== 'pending') return
  await tx.insert(approval).values({
    orgId: row.orgId,
    pendingActionId: row.id,
    approverUserId: decision.approverId,
    decision: 'approve',
    note: decision.note,
  })
  await tx
    .update(pendingAction)
    .set({ status: 'failed', error: message.slice(0, 500), decidedAt: sql`now()`, version: row.version + 1 })
    .where(eq(pendingAction.id, row.id))
  await auditApprover(tx, row, decision, 'failed', { error: message })
}
