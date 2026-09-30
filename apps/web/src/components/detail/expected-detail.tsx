'use client'

import { useQuery } from '@tanstack/react-query'
import { formatKes } from '../../lib/format'
import { EXPECTED_STATUS } from '../../lib/labels'
import { client, orpc } from '../../lib/orpc'
import { RequestAction } from '../requests/request-action'
import { LoadError, Loading } from '../ui/empty'
import { Status } from '../ui/status'
import { Time } from '../ui/time'
import { DetailSection, Facts } from './facts'
import { TransactionRef } from './refs'

export function ExpectedDetail({ id, canVoid }: { id: string; canVoid: boolean }) {
  const expected = useQuery(orpc.expected.get.queryOptions({ input: { id } }))
  const matches = useQuery(orpc.matches.list.queryOptions({ input: { expectedPaymentId: id } }))
  if (expected.isPending) return <Loading label="Loading expected payment…" />
  if (expected.isError) return <LoadError what="this expected payment" />
  const e = expected.data
  const outstanding = { minor: (BigInt(e.amountDue.minor) - BigInt(e.amountPaid.minor)).toString() }
  const payments = (matches.data?.items ?? []).flatMap((m) =>
    m.allocations.filter((a) => a.expectedPaymentId === id).map((a) => ({ match: m, amount: a.amount })),
  )

  return (
    <>
      <div className="detail-title">
        <p className="detail-heading mono">{e.reference}</p>
        <Status status={EXPECTED_STATUS[e.status] ?? { label: e.status, tone: 'neutral' }} />
      </div>
      <Facts
        items={[
          ['Description', e.description],
          ['Due', e.dueDate],
          ['Amount due', formatKes(e.amountDue)],
          ['Paid', formatKes(e.amountPaid)],
          ['Outstanding', e.status === 'void' ? null : formatKes(outstanding)],
          ['Added', <Time key="c" iso={e.createdAt} />],
        ]}
      />
      <DetailSection title="Payments">
        {payments.length === 0 ? (
          <p className="quiet">No payment matched yet.</p>
        ) : (
          <ul className="detail-list">
            {payments.map(({ match, amount }) => (
              <li key={match.id} data-muted={match.status === 'unmatched'}>
                <TransactionRef id={match.transactionId} />
                <span>{formatKes(amount)}</span>
                <span className="label">{match.status === 'unmatched' ? 'Undone' : 'Matched'}</span>
              </li>
            ))}
          </ul>
        )}
      </DetailSection>
      {canVoid && e.status === 'open' ? (
        <div className="actions">
          <RequestAction
            label="Void"
            submitLabel="Request void"
            submit={({ reason, idempotencyKey }) => client.expected.void({ id: e.id, version: e.version, reason, idempotencyKey })}
          />
        </div>
      ) : null}
    </>
  )
}
