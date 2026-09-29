import { CONSTRAINTS, SQLSTATE, pgConstraint, pgErrorCode, withOrg } from '@paysync/db'
import { DEFAULT_GUARD_POLICY } from '@paysync/guard'
import { ORPCError } from '@orpc/server'
import { authed } from '../base.js'
import { ActionError } from '../guarding/index.js'
import { DecisionError, recordDecision, recordFailure, type Decision } from './record.js'
import { stepUpProblem } from './step-up.js'
import { expireOld, toPendingAction } from './view.js'

const ownRequest = () => new ORPCError('FORBIDDEN', { message: 'You cannot decide on your own request.' })

export const approvalsDecide = authed.approvals.decide.handler(async ({ context, input, errors }) => {
  const { caller, db } = context
  const problem = stepUpProblem(caller, context.surface, DEFAULT_GUARD_POLICY)
  if (problem === 'not_web' || !caller.session) throw new ORPCError('FORBIDDEN', { message: 'Approvals happen in the web app.' })
  if (problem) throw errors.STEP_UP_REQUIRED({ data: { reason: problem } })

  const decision: Decision = {
    pendingActionId: input.id,
    version: input.version,
    decision: input.decision,
    note: input.note ?? null,
    approverId: caller.actorId,
    sessionId: caller.session.id,
  }
  await withOrg(db, caller.orgId, expireOld)

  try {
    const row = await withOrg(db, caller.orgId, (tx) => recordDecision(tx, decision), { isolation: 'serializable' })
    return await withOrg(db, caller.orgId, (tx) => toPendingAction(tx, row))
  } catch (error) {
    if (error instanceof DecisionError) {
      if (error.code === 'NOT_FOUND') throw errors.NOT_FOUND()
      if (error.code === 'OWN_REQUEST') throw ownRequest()
      if (error.code === 'STALE_STATE') throw errors.STALE_STATE({ data: { currentVersion: error.data.currentVersion ?? input.version } })
      throw errors.INVALID_STATE({ data: { status: error.data.status ?? 'unknown' } })
    }
    // The database enforces the same rules if code ever misses them.
    const constraint = pgConstraint(error)
    if (pgErrorCode(error) === SQLSTATE.checkViolation && constraint === CONSTRAINTS.approvalNotRequester) throw ownRequest()
    if (pgErrorCode(error) === SQLSTATE.uniqueViolation && constraint === CONSTRAINTS.approvalOncePerApprover) {
      throw errors.STALE_STATE({ data: { currentVersion: input.version + 1 } })
    }
    if (!(error instanceof ActionError)) throw error

    await withOrg(db, caller.orgId, (tx) => recordFailure(tx, decision, error.message))
    if (error.code === 'STALE_STATE') throw errors.STALE_STATE({ data: { currentVersion: Number(error.data.currentVersion) } })
    throw errors.INVALID_STATE({ data: { status: typeof error.data.status === 'string' ? error.data.status : 'failed' } })
  }
})
