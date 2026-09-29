import { ORPCError } from '@orpc/client'
import { z } from 'zod'

const ApprovalData = z.object({ approvalsRequired: z.number(), summary: z.string() })
const ReasonData = z.object({ reason: z.string() })
const BudgetData = z.object({ budget: z.string() })
const StatusData = z.object({ status: z.string() })

export interface GuardOutcome {
  readonly tone: 'info' | 'error'
  readonly message: string
}

/** What to tell the person after a guarded request: waiting for approval is the normal answer. */
export function guardOutcome(error: unknown): GuardOutcome {
  if (!(error instanceof ORPCError)) return { tone: 'error', message: 'Could not send the request.' }
  switch (error.code) {
    case 'APPROVAL_REQUIRED': {
      const data = ApprovalData.safeParse(error.data)
      const count = data.success ? data.data.approvalsRequired : 1
      return { tone: 'info', message: `Sent for approval: ${count === 2 ? 'two approvers' : 'an approver'} must confirm it in Approvals.` }
    }
    case 'BLOCKED': {
      const data = ReasonData.safeParse(error.data)
      return { tone: 'error', message: `Not allowed: ${data.success ? data.data.reason : 'blocked by policy'}.` }
    }
    case 'BUDGET_EXCEEDED': {
      const data = BudgetData.safeParse(error.data)
      return { tone: 'error', message: `Today's ${data.success ? data.data.budget : ''} budget is used up.` }
    }
    case 'STALE_STATE':
      return { tone: 'error', message: 'This changed since you opened it. Reload and try again.' }
    case 'INVALID_STATE': {
      const data = StatusData.safeParse(error.data)
      return { tone: 'error', message: `Not possible now (${data.success ? data.data.status.replaceAll('_', ' ') : 'invalid state'}).` }
    }
    case 'RATE_LIMITED':
      return { tone: 'error', message: 'Too many changes in a short time. Wait a minute.' }
    case 'ALLOCATION_REJECTED':
      return { tone: 'error', message: 'That amount does not fit what is unallocated.' }
    case 'FORBIDDEN':
      return { tone: 'error', message: 'Your role does not allow this.' }
    default:
      return { tone: 'error', message: 'Could not send the request.' }
  }
}
