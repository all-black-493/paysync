'use client'

import { isDefinedError } from '@orpc/client'
import { useMutation } from '@tanstack/react-query'
import { useState, type SubmitEvent } from 'react'
import { field, newIdempotencyKey, parseKes } from '../../lib/format'
import { orpc } from '../../lib/orpc'
import { useRefreshRecords } from '../../lib/refresh'
import { FormMessage, type Message } from '../ui/form-message'

export function CreateExpected() {
  const refresh = useRefreshRecords()
  const [message, setMessage] = useState<Message | null>(null)
  const create = useMutation(
    orpc.expected.create.mutationOptions({
      onSuccess: (data) => {
        setMessage({ tone: 'info', text: `Added ${data.result.reference}.` })
        refresh()
      },
      onError: (error) => {
        setMessage({
          tone: 'error',
          text: isDefinedError(error) && error.code === 'DUPLICATE_REFERENCE' ? 'That reference already exists.' : 'Could not save. Check the values and try again.',
        })
      },
    }),
  )

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    const minor = parseKes(field(form, 'amount'))
    if (minor === null || minor === '0') {
      setMessage({ tone: 'error', text: 'Enter an amount in shillings, like 3500 or 3,500.50.' })
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
    <form className="workbench" onSubmit={onSubmit} aria-label="Add an expected payment">
      <div className="form-row">
        <label className="field">
          <span>Reference</span>
          <input name="reference" required maxLength={64} placeholder="INV-1042" />
        </label>
        <label className="field">
          <span>Amount (KES)</span>
          <input name="amount" required inputMode="decimal" placeholder="3,500.00" />
        </label>
        <label className="field">
          <span>Due date</span>
          <input name="dueDate" type="date" />
        </label>
        <button type="submit" className="btn btn-primary" disabled={create.isPending} aria-busy={create.isPending}>
          Add
        </button>
      </div>
      <FormMessage message={message} />
    </form>
  )
}
