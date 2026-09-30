import { ORPCError } from '@orpc/server'
import { z } from 'zod'

const Pending = z.object({ pendingActionId: z.string(), summary: z.string(), approvalsRequired: z.number(), reasons: z.array(z.string()).default([]) })
const Reason = z.object({ reason: z.string() })

/** What an agent reads when the guard or the API refuses a call: plain data, never an instruction to retry around it. */
export type RefusedOutcome =
  | {
      readonly status: 'waiting_for_approval'
      readonly pendingActionId: string
      readonly approvalsRequired: number
      readonly summary: string
      readonly reasons: readonly string[]
      readonly next: string
    }
  | { readonly status: 'blocked'; readonly reason: string; readonly next: string }
  | { readonly status: 'refused'; readonly code: string; readonly message: string; readonly data: unknown; readonly next: string }

const NEXT: Record<string, string> = {
  STALE_STATE: 'The record changed. Read it again and use the new version.',
  BUDGET_EXCEEDED: "Today's budget for this action is used up. Tell the person; do not try again today.",
  RATE_LIMITED: 'Too many changes this minute. Wait before the next change.',
  FORBIDDEN: "The person you act for may not do this. Tell them; don't look for another way.",
  ALLOCATION_REJECTED: 'That amount does not fit what is unallocated or still due. Read the payment and expected payment again.',
  INVALID_STATE: 'The record is not in a state that allows this.',
  NOT_FOUND: 'Nothing with that id is visible to this person.',
}

/**
 * Guard and API refusals as tool results. Anything else is a real failure and
 * is thrown, so the AI SDK reports it as a tool error.
 */
export function toolOutcome(error: unknown): RefusedOutcome {
  if (!(error instanceof ORPCError)) throw error
  if (error.code === 'APPROVAL_REQUIRED') {
    const data = Pending.parse(error.data)
    return {
      status: 'waiting_for_approval',
      ...data,
      next: 'Nothing has changed yet. A person other than the one you act for must approve it in the Paysync web app; you cannot approve it. Check later with get_pending_action.',
    }
  }
  if (error.code === 'BLOCKED') {
    const data = Reason.safeParse(error.data)
    return { status: 'blocked', reason: data.success ? data.data.reason : error.message, next: 'This will not be allowed. Stop and tell the person why.' }
  }
  const code = String(error.code)
  if (code === 'INTERNAL_SERVER_ERROR') throw error
  const data: unknown = error.data
  return { status: 'refused', code, message: error.message, data: data ?? null, next: NEXT[code] ?? 'Stop and tell the person.' }
}
