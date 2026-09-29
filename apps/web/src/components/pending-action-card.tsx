'use client'

import type { PendingActionOutput } from '@paysync/contract'
import { isDefinedError } from '@orpc/client'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { formatDateTime, newIdempotencyKey } from '../lib/format'
import { orpc } from '../lib/orpc'
import { StepUp } from './step-up'

const LABELS: Record<string, string> = {
  'expected.void': 'Void expected payment',
  'matches.unmatch': 'Undo a match',
  'matches.confirm': 'Match a payment',
  'transactions.writeOffVariance': 'Write off a variance',
  'reversals.request': 'Reverse a payment (moves money)',
}

export interface Viewer {
  readonly id: string
  readonly email: string
  readonly canApprove: boolean
}

export function PendingActionCard({ action, viewer }: { action: PendingActionOutput; viewer: Viewer }) {
  const queryClient = useQueryClient()
  const [message, setMessage] = useState<string | null>(null)
  const [stepUpFor, setStepUpFor] = useState<'approve' | 'reject' | null>(null)
  const decide = useMutation(
    orpc.approvals.decide.mutationOptions({
      onSuccess: (updated) => {
        setMessage(updated.status === 'executed' ? 'Approved and done.' : updated.status === 'rejected' ? 'Rejected.' : 'Approved; waiting for the second approver.')
        void queryClient.invalidateQueries()
      },
      onError: (error, variables) => {
        if (isDefinedError(error) && error.code === 'STEP_UP_REQUIRED') {
          if (error.data.reason === 'session_too_old') setStepUpFor(variables.decision)
          else setMessage('Turn on two-factor authentication under Security before approving.')
          return
        }
        if (isDefinedError(error) && error.code === 'STALE_STATE') {
          setMessage('What this would change moved meanwhile; it was not done. Ask for a new request.')
          void queryClient.invalidateQueries()
          return
        }
        setMessage(error.message)
      },
    }),
  )

  const own = action.requestedBy.id === viewer.id
  const decidedByMe = action.approvals.some((a) => a.approverId === viewer.id)
  const approvedCount = action.approvals.filter((a) => a.decision === 'approve').length
  const run = (decision: 'approve' | 'reject') => {
    setMessage(null)
    decide.mutate({ id: action.id, version: action.version, decision, idempotencyKey: newIdempotencyKey('decide') })
  }

  return (
    <li className={action.money ? 'card row money' : 'card row'}>
      <div className="row-main">
        <span className={`badge ${action.status}`}>{action.status}</span>
        <div className="stack-tight">
          <strong>{LABELS[action.procedure] ?? action.procedure}</strong>
          <div>{action.summary}</div>
          <div className="muted small">
            Requested by {action.requestedBy.name ?? action.requestedBy.id} · {formatDateTime(action.createdAt)} · expires {formatDateTime(action.expiresAt)} ·{' '}
            {approvedCount}/{action.approvalsRequired} approval{action.approvalsRequired === 2 ? 's' : ''}
          </div>
          {action.reasons.length > 0 ? <div className="muted small">Why it needs approval: {action.reasons.join('; ')}</div> : null}
          {action.approvals.map((a) => (
            <div key={a.approverId} className="small">
              {a.decision === 'approve' ? '✓' : '✗'} {a.approverName ?? a.approverId}
              {a.note ? ` — ${a.note}` : ''}
            </div>
          ))}
          {action.error ? <div className="error small">{action.error}</div> : null}
          <details>
            <summary className="small">What it would change</summary>
            <pre className="preview">{JSON.stringify(action.preview, null, 2)}</pre>
          </details>
        </div>
      </div>
      {action.status === 'pending' && viewer.canApprove && !own && !decidedByMe && stepUpFor === null ? (
        <div className="actions">
          <button type="button" disabled={decide.isPending} onClick={() => { run('approve') }}>
            Approve
          </button>
          <button type="button" className="secondary" disabled={decide.isPending} onClick={() => { run('reject') }}>
            Reject
          </button>
        </div>
      ) : null}
      {action.status === 'pending' && own ? <div className="muted small">Your request: someone else must decide.</div> : null}
      {stepUpFor ? (
        <StepUp
          email={viewer.email}
          onDone={() => {
            const decision = stepUpFor
            setStepUpFor(null)
            run(decision)
          }}
        />
      ) : null}
      {message ? <div className="muted small">{message}</div> : null}
    </li>
  )
}
