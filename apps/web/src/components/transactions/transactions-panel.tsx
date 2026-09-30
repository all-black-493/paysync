'use client'

import type { MatchOutput } from '@paysync/contract'
import { useQuery } from '@tanstack/react-query'
import { formatAmount } from '../../lib/format'
import { TRANSACTION_STATUS } from '../../lib/labels'
import { orpc } from '../../lib/orpc'
import { RecordLink } from '../detail/record-link'
import { Empty, LoadError, Loading } from '../ui/empty'
import { Status } from '../ui/status'
import { Time } from '../ui/time'
import { TransactionActions, type TransactionPermissions } from './transaction-actions'

function byTransaction(matches: readonly MatchOutput[]): Map<string, MatchOutput[]> {
  const grouped = new Map<string, MatchOutput[]>()
  for (const m of matches) grouped.set(m.transactionId, [...(grouped.get(m.transactionId) ?? []), m])
  return grouped
}

export function TransactionsPanel({ can }: { can: TransactionPermissions }) {
  const list = useQuery(orpc.transactions.list.queryOptions({ input: {} }))
  const active = useQuery({ ...orpc.matches.list.queryOptions({ input: { status: 'active', limit: 100 } }), enabled: can.unmatch })
  if (list.isPending) return <Loading label="Loading transactions…" />
  if (list.isError) return <LoadError what="transactions" />
  if (list.data.items.length === 0) return <Empty title="No payments yet.">Payments to your Paybill or Till appear here once M-Pesa reports them.</Empty>

  const anyActions = can.writeOff || can.reverse || can.unmatch
  const matches = byTransaction(active.data?.items ?? [])

  return (
    <table className="ledger">
      <thead>
        <tr>
          <th scope="col">Receipt</th>
          <th scope="col">Received</th>
          <th scope="col">Payer reference</th>
          <th scope="col" className="num">
            Amount (KES)
          </th>
          <th scope="col" className="num">
            Unallocated
          </th>
          <th scope="col">Status</th>
          {anyActions ? (
            <th scope="col">
              <span className="visually-hidden">Requests</span>
            </th>
          ) : null}
        </tr>
      </thead>
      <tbody>
        {list.data.items.map((t) => (
          <tr key={t.id} className="clickable">
            <td className="mono" data-label="Receipt">
              <RecordLink kind="transaction" id={t.id} stretch>
                {t.receiptNumber}
              </RecordLink>
            </td>
            <td className="nowrap" data-label="Received">
              <Time iso={t.transactedAt} style="short" />
            </td>
            <td className="wide" data-label="Payer reference">
              <span className="untrusted">{t.billRefNumber ?? '—'}</span>
            </td>
            <td className="num amount" data-label="Amount (KES)">
              {formatAmount(t.amount)}
            </td>
            <td className="num amount" data-label="Unallocated">
              {formatAmount(t.unallocated)}
            </td>
            <td data-label="Status">
              <Status status={TRANSACTION_STATUS[t.status] ?? { label: t.status, tone: 'neutral' }} />
            </td>
            {anyActions ? (
              <td className="row-actions">
                <TransactionActions transaction={t} matches={matches.get(t.id) ?? []} can={can} />
              </td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
