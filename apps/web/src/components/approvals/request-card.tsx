'use client'

import type { PendingActionOutput } from '@paysync/contract'
import { isDefinedError } from '@orpc/client'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { newIdempotencyKey } from '../../lib/format'
import { flaggedReasons, PROCEDURES, REQUEST_STATUS } from '../../lib/labels'
import { orpc } from '../../lib/orpc'
import { useRefreshRecords } from '../../lib/refresh'
import { FormMessage, type Message } from '../ui/form-message'
import { Status } from '../ui/status'
import { Time } from '../ui/time'
import { RequestChanges } from './request-changes'
import { StepUp } from './step-up'

export interface Viewer {
  readonly id: string
  readonly email: string
  readonly canApprove: boolean
}

type Decision = 'approve' | 'reject'

export function RequestCard({ action, viewer }: { action: PendingActionOutput; viewer: Viewer }) {
  const refresh = useRefreshRecords()
  const [message, setMessage] = useState<Message | null>(null)
  const [stepUpFor, setStepUpFor] = useState<Decision | null>(null)
  const decide = useMutation(
    orpc.approvals.decide.mutationOptions({
      onSuccess: (updated) => {
        const text = updated.status === 'executed' ? 'Approved and done.' : updated.status === 'rejected' ? 'Rejected.' : 'Approved. Waiting for the second approver.'
        setMessage({ tone: 'info', text })
        refresh()
      },
      onError: (error, variables) => {
        if (isDefinedError(error) && error.code === 'STEP_UP_REQUIRED') {
          if (error.data.reason === 'session_too_old') setStepUpFor(variables.decision)
          else setMessage({ tone: 'error', text: 'Turn on two-factor authentication under Security before deciding.' })
          return
        }
        if (isDefinedError(error) && error.code === 'STALE_STATE') {
          setMessage({ tone: 'error', text: 'The record changed after this request, so nothing was done. Ask for a new request.' })
          refresh()
          return
        }
        setMessage({ tone: 'error', text: error.message })
      },
    }),
  )

  const own = action.requestedBy.id === viewer.id
  const decidedByMe = action.approvals.some((a) => a.approverId === viewer.id)
  const approvedCount = action.approvals.filter((a) => a.decision === 'approve').length
  const pending = action.status === 'pending'
  const canDecide = pending && viewer.canApprove && !own && !decidedByMe && stepUpFor === null
  const flags = flaggedReasons(action.reasons)
  const run = (decision: Decision) => {
    setMessage(null)
    decide.mutate({ id: action.id, version: action.version, decision, idempotencyKey: newIdempotencyKey('decide') })
  }

  return (
    <li className="request" data-money={action.money}>
      <div className="request-main">
        <div className="request-line">
          <Status status={REQUEST_STATUS[action.status]} />
          <span className="label">{PROCEDURES[action.procedure] ?? action.procedure}</span>
          {action.money ? <span className="label error">Moves money</span> : null}
          <span className="label">
            {approvedCount} of {action.approvalsRequired} {action.approvalsRequired === 1 ? 'approval' : 'approvals'}
          </span>
        </div>
        <p className="request-summary">{action.summary}</p>
        <p className="record-meta">
          {action.requestedBy.name ?? 'Someone'} asked <Time iso={action.createdAt} />
          {pending ? (
            <>
              {' '}
              · expires <Time iso={action.expiresAt} />
            </>
          ) : null}
        </p>
        {flags.length > 0 ? (
          <ul className="request-flags">
            {flags.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        ) : null}
        {action.approvals.length > 0 ? (
          <ul className="request-decisions">
            {action.approvals.map((a) => (
              <li key={a.approverId}>
                {a.decision === 'approve' ? 'Approved' : 'Rejected'} by {a.approverName ?? 'an approver'} <Time iso={a.at} />
                {a.note ? `: ${a.note}` : ''}
              </li>
            ))}
          </ul>
        ) : null}
        {action.error ? <p className="error">{action.error}</p> : null}
      </div>
      <div className="request-side">
        <RequestChanges
          title={action.status === 'executed' ? 'Result' : pending ? 'After approval' : 'Would have changed'}
          record={action.status === 'executed' ? action.result : action.preview}
        />
        {canDecide ? (
          <div className="actions">
            <button type="button" className="btn btn-primary" disabled={decide.isPending} aria-busy={decide.isPending} onClick={() => { run('approve') }}>
              Approve
            </button>
            <button type="button" className="btn" disabled={decide.isPending} onClick={() => { run('reject') }}>
              Reject
            </button>
          </div>
        ) : null}
        {pending && own ? <p className="quiet small">Your request. Another approver decides.</p> : null}
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
        <FormMessage message={message} />
      </div>
    </li>
  )
}
