'use client'

import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { orpc } from '../lib/orpc'
import { PendingActionCard, type Viewer } from './pending-action-card'

type Status = 'pending' | 'executed' | 'rejected' | 'failed' | 'expired'

const STATUSES: ReadonlyArray<readonly [Status, string]> = [
  ['pending', 'Waiting'],
  ['executed', 'Done'],
  ['rejected', 'Rejected'],
  ['failed', 'Failed'],
  ['expired', 'Expired'],
]

/** Requests waiting for a person: every member sees them, approvers decide. */
export function ApprovalsPanel({ viewer }: { viewer: Viewer }) {
  const [status, setStatus] = useState<Status>('pending')
  const list = useQuery(orpc.pendingActions.list.queryOptions({ input: { status } }))
  return (
    <section className="stack">
      <div className="filters" role="group" aria-label="Show">
        {STATUSES.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={value === status ? 'tab active' : 'tab'}
            onClick={() => {
              setStatus(value)
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {list.isPending ? <p className="muted">Loading…</p> : null}
      {list.isError ? <p className="error">Could not load approvals.</p> : null}
      {list.data?.items.length === 0 ? <p className="muted">Nothing here.</p> : null}
      <ul className="list">
        {list.data?.items.map((action) => (
          <PendingActionCard key={action.id} action={action} viewer={viewer} />
        ))}
      </ul>
    </section>
  )
}
