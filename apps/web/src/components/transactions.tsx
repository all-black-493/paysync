'use client'

import { useQuery } from '@tanstack/react-query'
import { formatDateTime, formatKes } from '../lib/format'
import { orpc } from '../lib/orpc'
import { TransactionActions, type TransactionPermissions } from './transaction-actions'

export function TransactionsPanel({ can }: { can: TransactionPermissions }) {
  const list = useQuery(orpc.transactions.list.queryOptions({ input: {} }))
  if (list.isPending) return <p className="muted">Loading transactions…</p>
  if (list.isError) return <p className="error">Could not load transactions.</p>
  const anyActions = can.writeOff || can.reverse || can.unmatch
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Receipt</th>
          <th>When</th>
          <th>Payer reference</th>
          <th className="num">Amount</th>
          <th className="num">Unallocated</th>
          <th>Status</th>
          {anyActions ? <th>Requests</th> : null}
        </tr>
      </thead>
      <tbody>
        {list.data.items.map((t) => (
          <tr key={t.id}>
            <td className="mono">{t.receiptNumber}</td>
            <td>{formatDateTime(t.transactedAt)}</td>
            <td>
              {/* Typed by the payer: shown as plain text, never interpreted. */}
              <span className="untrusted" title="Entered by the payer">
                {t.billRefNumber ?? '—'}
              </span>
            </td>
            <td className="num">{formatKes(t.amount)}</td>
            <td className="num">{formatKes(t.unallocated)}</td>
            <td>
              <span className={`badge ${t.status}`}>{t.status.replaceAll('_', ' ')}</span>
            </td>
            {anyActions ? (
              <td>
                <TransactionActions transaction={t} can={can} />
              </td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
