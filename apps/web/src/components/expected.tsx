'use client'

import { isDefinedError } from '@orpc/client'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type SubmitEvent } from 'react'
import { field, formatKes, newIdempotencyKey, parseKes } from '../lib/format'
import { client, orpc } from '../lib/orpc'
import { RequestAction } from './request-action'

export function ExpectedPanel({ canWrite, canVoid }: { canWrite: boolean; canVoid: boolean }) {
  const list = useQuery(orpc.expected.list.queryOptions({ input: {} }))
  return (
    <section>
      {canWrite ? <CreateExpected /> : null}
      {list.isPending ? <p className="muted">Loading…</p> : null}
      {list.isError ? <p className="error">Could not load expected payments.</p> : null}
      {list.data ? (
        <table className="table">
          <thead>
            <tr>
              <th>Reference</th>
              <th>Due</th>
              <th className="num">Amount due</th>
              <th className="num">Paid</th>
              <th>Status</th>
              {canVoid ? <th>Requests</th> : null}
            </tr>
          </thead>
          <tbody>
            {list.data.items.map((e) => (
              <tr key={e.id}>
                <td>{e.reference}</td>
                <td>{e.dueDate ?? '—'}</td>
                <td className="num">{formatKes(e.amountDue)}</td>
                <td className="num">{formatKes(e.amountPaid)}</td>
                <td>
                  <span className={`badge ${e.status}`}>{e.status.replace('_', ' ')}</span>
                </td>
                {canVoid ? (
                  <td>
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
    </section>
  )
}

function CreateExpected() {
  const queryClient = useQueryClient()
  const [message, setMessage] = useState<string | null>(null)
  const create = useMutation(
    orpc.expected.create.mutationOptions({
      onSuccess: () => {
        setMessage('Saved.')
        void queryClient.invalidateQueries({ queryKey: orpc.expected.key() })
      },
      onError: (error) => {
        setMessage(
          isDefinedError(error) && error.code === 'DUPLICATE_REFERENCE'
            ? 'That reference already exists.'
            : 'Could not save. Check the values and try again.',
        )
      },
    }),
  )

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    const minor = parseKes(field(form, 'amount'))
    if (minor === null || minor === '0') {
      setMessage('Enter an amount in shillings, like 3500 or 3,500.50.')
      return
    }
    const dueDate = field(form, 'dueDate')
    create.mutate(
      {
        reference: field(form, 'reference'),
        amountDue: { minor, currency: 'KES' },
        ...(dueDate ? { dueDate } : {}),
        idempotencyKey: newIdempotencyKey('expected'),
      },
      {
        onSuccess: () => {
          formElement.reset()
        },
      },
    )
  }

  return (
    <form className="card inline-form create" onSubmit={onSubmit}>
      <label>
        Reference
        <input name="reference" required maxLength={64} placeholder="INV-1042" />
      </label>
      <label>
        Amount (KES)
        <input name="amount" required inputMode="decimal" placeholder="3,500.00" />
      </label>
      <label>
        Due date
        <input name="dueDate" type="date" />
      </label>
      <button type="submit" disabled={create.isPending}>
        Add expected payment
      </button>
      {message ? <span className="muted">{message}</span> : null}
    </form>
  )
}
