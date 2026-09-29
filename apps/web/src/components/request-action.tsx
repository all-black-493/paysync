'use client'

import { useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode, type SubmitEvent } from 'react'
import { field, newIdempotencyKey } from '../lib/format'
import { guardOutcome, type GuardOutcome } from '../lib/guard-outcome'

export interface RequestInput {
  readonly reason: string
  readonly form: FormData
  readonly idempotencyKey: string
}

/**
 * A guarded request with a reason (void, write-off, reversal, unmatch). The
 * usual answer is "sent for approval"; nothing changes until someone approves.
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
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [outcome, setOutcome] = useState<GuardOutcome | null>(null)

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setPending(true)
    try {
      await submit({ reason: field(form, 'reason').trim(), form, idempotencyKey: newIdempotencyKey('request') })
      setOutcome({ tone: 'info', message: 'Done.' })
      setOpen(false)
    } catch (error) {
      const result = guardOutcome(error)
      setOutcome(result)
      if (result.tone === 'info') setOpen(false)
    } finally {
      setPending(false)
      void queryClient.invalidateQueries()
    }
  }

  if (!open) {
    return (
      <span className="request-action">
        <button type="button" className="secondary small-button" onClick={() => { setOpen(true); setOutcome(null) }}>
          {label}
        </button>
        {outcome ? <span className={outcome.tone === 'error' ? 'error small' : 'muted small'}>{outcome.message}</span> : null}
      </span>
    )
  }

  return (
    <form className="inline-form request-form" onSubmit={(e) => void onSubmit(e)}>
      {children}
      <label>
        Reason
        <input name="reason" required minLength={3} maxLength={500} placeholder="Why, for the approver" />
      </label>
      <button type="submit" disabled={pending}>
        {submitLabel}
      </button>
      <button type="button" className="secondary" onClick={() => { setOpen(false) }}>
        Cancel
      </button>
      {outcome ? <span className={outcome.tone === 'error' ? 'error small' : 'muted small'}>{outcome.message}</span> : null}
    </form>
  )
}
