'use client'

import { useQuery } from '@tanstack/react-query'
import { formatAmount } from '../../lib/format'
import { EXPECTED_STATUS } from '../../lib/labels'
import { client, orpc } from '../../lib/orpc'
import { RequestAction } from '../requests/request-action'
import { Empty, LoadError, Loading } from '../ui/empty'
import { Status } from '../ui/status'
import { CreateExpected } from './create-expected'

export function ExpectedPanel({ canWrite, canVoid }: { canWrite: boolean; canVoid: boolean }) {
  const list = useQuery(orpc.expected.list.queryOptions({ input: {} }))
  return (
    <div className="stack-lg">
      {canWrite ? <CreateExpected /> : null}
      {list.isPending ? <Loading label="Loading expected payments…" /> : null}
      {list.isError ? <LoadError what="expected payments" /> : null}
      {list.data?.items.length === 0 ? (
        <Empty title="Nothing expected yet.">Add invoices, rent or fees here so incoming payments can be matched to them.</Empty>
      ) : null}
      {list.data && list.data.items.length > 0 ? (
        <table className="ledger">
          <thead>
            <tr>
              <th scope="col">Reference</th>
              <th scope="col">Due</th>
              <th scope="col" className="num">
                Amount due (KES)
              </th>
              <th scope="col" className="num">
                Paid
              </th>
              <th scope="col">Status</th>
              {canVoid ? (
                <th scope="col">
                  <span className="visually-hidden">Requests</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {list.data.items.map((e) => (
              <tr key={e.id}>
                <td className="mono" data-label="Reference">
                  {e.reference}
                </td>
                <td className="nowrap" data-label="Due">
                  {e.dueDate ?? '—'}
                </td>
                <td className="num amount" data-label="Amount due (KES)">
                  {formatAmount(e.amountDue)}
                </td>
                <td className="num amount" data-label="Paid">
                  {formatAmount(e.amountPaid)}
                </td>
                <td data-label="Status">
                  <Status status={EXPECTED_STATUS[e.status] ?? { label: e.status, tone: 'neutral' }} />
                </td>
                {canVoid ? (
                  <td className="row-actions">
                    {e.status === 'open' ? (
                      <RequestAction
                        label="Void"
                        submitLabel="Request void"
                        submit={({ reason, idempotencyKey }) => client.expected.void({ id: e.id, version: e.version, reason, idempotencyKey })}
                      />
                    ) : null}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  )
}
