import { schema, type Tx } from '@paysync/db'
import { DEFAULT_GUARD_POLICY } from '@paysync/guard'
import { z } from 'zod'
import { APPROVABLE } from '../actions/index.js'
import { ActionError, validateStoredInput, type Actor } from '../guarding/index.js'
import { requestHash } from '../mutate.js'
import type { PendingRow } from './view.js'

const { auditEvent, idempotencyRecord } = schema

const StoredRequest = z.record(z.string(), z.unknown())
const Surface = z.enum(['web', 'rest', 'ai-sdk', 'mcp', 'system']).catch('system')

/**
 * Runs an approved request once, inside the approval's transaction, as its
 * requester and under its original idempotency key: a retry of the original
 * call then returns this result instead of running again.
 */
export async function executeApproved(tx: Tx, row: PendingRow, approvers: readonly string[]) {
  const action = Object.hasOwn(APPROVABLE, row.procedure) ? APPROVABLE[row.procedure] : undefined
  if (!action) throw new ActionError('INVALID_STATE', 'this action cannot be executed', { status: 'unknown_procedure' })
  const input = StoredRequest.parse(await validateStoredInput(row.procedure, row.input))
  const actor: Actor = { orgId: row.orgId, actorId: row.requestedBy, kind: row.requesterKind === 'api_key' ? 'api_key' : 'user' }
  const budget = await action.overBudget(tx, input, DEFAULT_GUARD_POLICY)
  if (budget) throw new ActionError('INVALID_STATE', `the ${budget.budget} budget is used up for today`, { status: 'budget_exceeded' })

  const { result, changed } = await action.run(tx, input, actor)
  const response = { dryRun: false, changed, result }
  await tx.insert(idempotencyRecord).values({
    orgId: row.orgId,
    key: row.idempotencyKey,
    action: row.procedure,
    requestHash: requestHash(input),
    response,
  })
  await tx.insert(auditEvent).values({
    orgId: row.orgId,
    surface: Surface.parse(row.surface),
    userId: row.requestedBy,
    action: row.procedure,
    input: row.input,
    decision: 'approved',
    outcome: changed ? 'changed' : 'unchanged',
    details: { pendingActionId: row.id, approvedBy: approvers },
  })
  return response
}
