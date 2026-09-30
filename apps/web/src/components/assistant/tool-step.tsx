'use client'

import type { DynamicToolUIPart, ToolUIPart } from 'ai'
import { getToolName } from 'ai'
import { z } from 'zod'

const LABELS: Record<string, string> = {
  whoami: 'Checked who you are',
  list_exceptions: 'Read the exceptions',
  get_exception: 'Read an exception',
  list_transactions: 'Read payments',
  get_transaction: 'Read a payment',
  list_expected_payments: 'Read expected payments',
  get_expected_payment: 'Read an expected payment',
  suggest_matches: 'Looked for matches',
  list_matches: 'Read matches',
  list_pending_actions: 'Read approval requests',
  get_pending_action: 'Read an approval request',
  daily_summary: "Read today's totals",
  confirm_match: 'Matched a payment',
  annotate_exception: 'Added a note',
  resolve_exception: 'Closed an exception',
  create_expected_payment: 'Added an expected payment',
  update_expected_payment: 'Changed an expected payment',
  void_expected_payment: 'Asked to void an expected payment',
  unmatch: 'Asked to undo a match',
  write_off_variance: 'Asked for a write-off',
  request_reversal: 'Asked for a reversal',
}

const Outcome = z.object({ status: z.enum(['waiting_for_approval', 'blocked', 'refused']), reason: z.string().optional(), message: z.string().optional(), approvalsRequired: z.number().optional() })

function outcomeText(output: unknown): string | null {
  const parsed = Outcome.safeParse(output)
  if (!parsed.success) return null
  if (parsed.data.status === 'waiting_for_approval') return `Waiting for ${parsed.data.approvalsRequired === 2 ? 'two approvers' : 'an approver'} in Approvals`
  if (parsed.data.status === 'blocked') return `Blocked: ${parsed.data.reason ?? 'not allowed'}`
  return `Not done: ${parsed.data.message ?? 'refused'}`
}

/** One tool call as a quiet line; confirmation requests get their own buttons. */
export function ToolStep({
  part,
  onDecide,
}: {
  part: ToolUIPart | DynamicToolUIPart
  onDecide: (id: string, approved: boolean) => void
}) {
  const name = getToolName(part)
  const label = LABELS[name] ?? name.replaceAll('_', ' ')

  if (part.state === 'approval-requested') {
    return (
      <div className="assistant-confirm">
        <p>
          <strong>{label}?</strong> This only files the request; someone else still approves it.
        </p>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={() => { onDecide(part.approval.id, true) }}>
            Go ahead
          </button>
          <button type="button" className="btn" onClick={() => { onDecide(part.approval.id, false) }}>
            Don’t
          </button>
        </div>
      </div>
    )
  }

  const status =
    part.state === 'output-available'
      ? (outcomeText(part.output) ?? 'Done')
      : part.state === 'output-error'
        ? 'Failed'
        : part.state === 'output-denied'
          ? 'You said no'
          : 'Working…'
  return (
    <p className="assistant-step">
      <span className="label">{label}</span> <span className="quiet">{status}</span>
    </p>
  )
}
