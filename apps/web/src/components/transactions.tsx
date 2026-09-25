'use client'

import { useQuery } from '@tanstack/react-query'
import { formatDateTime, formatKes } from '../lib/format'
import { orpc } from '../lib/orpc'

export function TransactionsPanel() {
  const list = useQuery(orpc.transactions.list.queryOptions({ input: {} }))
  if (list.isPending) return <p className="muted">Loading transactions…</p>
  if (list.isError) return <p className="error">Could not load transactions.</p>
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
              <span className={`badge ${t.status}`}>{t.status.replace('_', ' ')}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
