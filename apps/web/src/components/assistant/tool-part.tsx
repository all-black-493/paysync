'use client'

import type { DynamicToolUIPart, ToolUIPart } from 'ai'
import { getToolName } from 'ai'
import { z } from 'zod'
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
} from '@/components/ai-elements/confirmation'
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@/components/ai-elements/tool'

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
  confirm_match: 'Match a payment',
  annotate_exception: 'Add a note',
  resolve_exception: 'Close an exception',
  create_expected_payment: 'Add an expected payment',
  update_expected_payment: 'Change an expected payment',
  void_expected_payment: 'Ask to void an expected payment',
  unmatch: 'Ask to undo a match',
  write_off_variance: 'Ask for a write-off',
  request_reversal: 'Ask for a reversal',
}

const Refused = z.object({ status: z.enum(['waiting_for_approval', 'blocked', 'refused']), reason: z.string().optional(), message: z.string().optional(), approvalsRequired: z.number().optional() })

/** A guard answer in words: the part the person needs, above the raw result. */
function outcomeText(output: unknown): string | null {
  const parsed = Refused.safeParse(output)
  if (!parsed.success) return null
  if (parsed.data.status === 'waiting_for_approval') return `Filed. Waiting for ${parsed.data.approvalsRequired === 2 ? 'two approvers' : 'an approver'} in Approvals.`
  if (parsed.data.status === 'blocked') return `Blocked: ${parsed.data.reason ?? 'not allowed'}.`
  return `Not done: ${parsed.data.message ?? 'refused'}.`
}

/** One tool call (AI Elements Tool), with the chat-level confirmation when the tool asks for one. */
export function ToolPart({ part, onDecide }: { part: ToolUIPart | DynamicToolUIPart; onDecide: (id: string, approved: boolean) => void }) {
  const name = getToolName(part)
  const title = LABELS[name] ?? name.replaceAll('_', ' ')
  const outcome = part.state === 'output-available' ? outcomeText(part.output) : null
  const type = part.type === 'dynamic-tool' ? (`tool-${name}` as const) : part.type

  return (
    <div className="grid gap-2">
      <Tool defaultOpen={false}>
        <ToolHeader title={title} type={type} state={part.state} />
        <ToolContent>
          <ToolInput input={part.input} />
          {part.state === 'output-available' || part.state === 'output-error' ? (
            <ToolOutput output={part.state === 'output-available' ? part.output : undefined} errorText={part.state === 'output-error' ? part.errorText : undefined} />
          ) : null}
        </ToolContent>
      </Tool>
      {outcome ? <p className="text-sm text-muted-foreground">{outcome}</p> : null}
      <Confirmation approval={part.approval} state={part.state}>
        <ConfirmationTitle>
          <ConfirmationRequest>{title}? This only files the request; someone else still approves it in the web app.</ConfirmationRequest>
          <ConfirmationAccepted>You said go ahead.</ConfirmationAccepted>
          <ConfirmationRejected>You said no.</ConfirmationRejected>
        </ConfirmationTitle>
        {part.state === 'approval-requested' ? (
          <ConfirmationActions>
            <ConfirmationAction variant="outline" onClick={() => { onDecide(part.approval.id, false) }}>
              Don’t
            </ConfirmationAction>
            <ConfirmationAction onClick={() => { onDecide(part.approval.id, true) }}>Go ahead</ConfirmationAction>
          </ConfirmationActions>
        ) : null}
      </Confirmation>
    </div>
  )
}
