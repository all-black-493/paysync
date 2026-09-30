'use client'

import { useQuery } from '@tanstack/react-query'
import { formatKes } from '../../lib/format'
import { humanize, TRANSACTION_STATUS } from '../../lib/labels'
import { orpc } from '../../lib/orpc'
import { TransactionActions, type TransactionPermissions } from '../transactions/transaction-actions'
import { LoadError, Loading } from '../ui/empty'
import { Status } from '../ui/status'
import { Time } from '../ui/time'
import { DetailSection, Facts } from './facts'
import { ExpectedRef } from './refs'

export function TransactionDetail({ id, can }: { id: string; can: TransactionPermissions }) {
  const transaction = useQuery(orpc.transactions.get.queryOptions({ input: { id } }))
  const matches = useQuery(orpc.matches.list.queryOptions({ input: { transactionId: id } }))
  if (transaction.isPending) return <Loading label="Loading payment…" />
  if (transaction.isError) return <LoadError what="this payment" />
  const t = transaction.data
  const allocations = (matches.data?.items ?? []).flatMap((m) => m.allocations.map((a) => ({ match: m, allocation: a })))

  return (
    <>
      <div className="detail-title">
        <p className="detail-heading mono">{t.receiptNumber}</p>
        <Status status={TRANSACTION_STATUS[t.status] ?? { label: t.status, tone: 'neutral' }} />
      </div>
      <Facts
        items={[
          ['Received', <Time key="at" iso={t.transactedAt} style="short" />],
          ['Amount', formatKes(t.amount)],
          ['Allocated', formatKes(t.allocated)],
          ['Written off', t.writtenOff.minor === '0' ? null : formatKes(t.writtenOff)],
          ['Unallocated', formatKes(t.unallocated)],
          ['Paid to', `${humanize(t.shortcode.kind)} ${t.shortcode.code}`],
          ['Reported by', t.source === 'c2b' ? 'M-Pesa confirmation' : t.source === 'stk' ? 'STK push' : humanize(t.source)],
          ['Verified', t.verifiedAt ? <Time key="v" iso={t.verifiedAt} style="short" /> : 'Not yet'],
        ]}
      />
      <DetailSection title="Payer reference">
        <p className="untrusted">{t.billRefNumber ?? 'None given'}</p>
      </DetailSection>
      <DetailSection title="Allocations">
        {allocations.length === 0 ? (
          <p className="quiet">Not matched to any expected payment.</p>
        ) : (
          <ul className="detail-list">
            {allocations.map(({ match, allocation }) => (
              <li key={`${match.id}-${allocation.expectedPaymentId}`} data-muted={match.status === 'unmatched'}>
                <ExpectedRef id={allocation.expectedPaymentId} />
                <span>{formatKes(allocation.amount)}</span>
                <span className="label">{match.status === 'unmatched' ? 'Undone' : humanize(match.method)}</span>
              </li>
            ))}
          </ul>
        )}
      </DetailSection>
      <TransactionActions transaction={t} matches={(matches.data?.items ?? []).filter((m) => m.status === 'active')} can={can} />
    </>
  )
}
