'use client'

import type { PendingActionOutput } from '@paysync/contract'
import { useQuery } from '@tanstack/react-query'
import { orpc } from '../../lib/orpc'
import { useUrlParam } from '../../lib/url-state'
import { Empty, LoadError, Loading } from '../ui/empty'
import { RequestCard, type Viewer } from './request-card'

type Status = PendingActionOutput['status']

const STATUSES: ReadonlyArray<readonly [Status, string]> = [
  ['pending', 'Waiting'],
  ['executed', 'Done'],
  ['rejected', 'Rejected'],
  ['failed', 'Failed'],
  ['expired', 'Expired'],
]

const EMPTY: Record<Status, readonly [string, string]> = {
  pending: ['Nothing waits for approval.', 'Voids, write-offs, undone matches and reversals appear here until someone other than the requester decides.'],
  executed: ['Nothing approved yet.', 'Approved requests are listed here once they have run.'],
  rejected: ['Nothing rejected.', 'Rejected requests stay here as a record.'],
  failed: ['Nothing failed.', 'A request fails when what it would change moved before approval.'],
  expired: ['Nothing expired.', 'Requests expire after three days without a decision.'],
}

/** Requests waiting for a person: every member sees them, approvers decide. */
export function ApprovalsPanel({ viewer }: { viewer: Viewer }) {
  const [status, setStatus] = useUrlParam<Status>(
    'status',
    STATUSES.map(([s]) => s),
    'pending',
  )
  const list = useQuery(orpc.pendingActions.list.queryOptions({ input: { status } }))
  const [emptyTitle, emptyHint] = EMPTY[status]

  return (
    <div className="stack-lg">
      <div className="panel-bar">
        <div className="filters" role="group" aria-label="Show requests">
          {STATUSES.map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={value === status}
              onClick={() => {
                setStatus(value)
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {list.isPending ? <Loading label="Loading requests…" /> : null}
      {list.isError ? <LoadError what="requests" /> : null}
      {list.data?.items.length === 0 ? <Empty title={emptyTitle}>{emptyHint}</Empty> : null}
      {list.data && list.data.items.length > 0 ? (
        <ul className="requests">
          {list.data.items.map((action) => (
            <RequestCard key={action.id} action={action} viewer={viewer} />
          ))}
        </ul>
      ) : null}
    </div>
  )
}
