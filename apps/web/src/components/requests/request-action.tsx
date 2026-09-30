'use client'

import { useState, type ReactNode, type SubmitEvent } from 'react'
import { field, newIdempotencyKey } from '../../lib/format'
import { guardOutcome } from '../../lib/guard-outcome'
import { useRefreshRecords } from '../../lib/refresh'
import { FormMessage, type Message } from '../ui/form-message'

export interface RequestInput {
  readonly reason: string
  readonly form: FormData
  readonly idempotencyKey: string
}

/**
 * A guarded request with a reason (void, write-off, reversal, undo match).
 * The usual answer is "sent for approval"; nothing changes until someone approves.
 */
export function RequestAction({
  label,
  submitLabel,
  submit,
  children,
}: {
  label: string
  submitLabel: string
  submit: (input: RequestInput) => Promise<unknown>
  children?: ReactNode
}) {
  const refresh = useRefreshRecords()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setPending(true)
    try {
      await submit({ reason: field(form, 'reason').trim(), form, idempotencyKey: newIdempotencyKey('request') })
      setMessage({ tone: 'info', text: 'Done.' })
      setOpen(false)
    } catch (error) {
      const outcome = guardOutcome(error)
      setMessage({ tone: outcome.tone, text: outcome.message })
      if (outcome.tone === 'info') setOpen(false)
    } finally {
      setPending(false)
      refresh()
    }
  }

  if (!open) {
    return (
      <div className="stack">
        <button
          type="button"
          className="btn"
          onClick={() => {
            setOpen(true)
            setMessage(null)
          }}
        >
          {label}
        </button>
        {message ? <FormMessage message={message} /> : null}
      </div>
    )
  }

  return (
    <form className="inline-request reveal" onSubmit={(e) => void onSubmit(e)}>
      {children}
      <label className="field">
        <span>Reason for the approver</span>
        <input name="reason" required minLength={3} maxLength={500} autoFocus={!children} />
      </label>
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={pending} aria-busy={pending}>
          {submitLabel}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setOpen(false)
          }}
        >
          Cancel
        </button>
      </div>
      <FormMessage message={message} />
    </form>
  )
}
