'use client'

import type { MatchSuggestionsOutput } from '@paysync/contract'
import { isDefinedError } from '@orpc/client'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState, type SubmitEvent } from 'react'
import { field, formatAmount, formatKes, newIdempotencyKey, parseKes } from '../../lib/format'
import { humanize } from '../../lib/labels'
import { orpc } from '../../lib/orpc'
import { useRefreshRecords } from '../../lib/refresh'
import { FormMessage, type Message } from '../ui/form-message'

type Suggestion = MatchSuggestionsOutput['suggestions'][number]

const REASONS: Record<Suggestion['reasons'][number], string> = {
  same_reference: 'same reference',
  same_reference_normalized: 'same reference, written differently',
  similar_reference: 'similar reference',
  amount_equals_due: 'amount equals what is due',
  amount_below_due: 'part of what is due',
  due_date_near: 'due around the payment date',
}

export function MatchPanel({ transactionId, onDone }: { transactionId: string; onDone: () => void }) {
  const suggestions = useQuery(orpc.matches.suggest.queryOptions({ input: { transactionId } }))
  if (suggestions.isPending) return <div className="workbench quiet" role="status">Looking for expected payments…</div>
  if (suggestions.isError) return <div className="workbench error" role="alert">Could not load suggestions.</div>
  const { transaction, suggestions: items } = suggestions.data

  return (
    <div className="workbench">
      <dl className="facts">
        <div>
          <dt>Receipt</dt>
          <dd className="mono">{transaction.receiptNumber}</dd>
        </div>
        <div>
          <dt>Amount</dt>
          <dd>{formatKes(transaction.amount)}</dd>
        </div>
        <div>
          <dt>Unallocated</dt>
          <dd>{formatKes(transaction.unallocated)}</dd>
        </div>
        <div>
          <dt>Payer reference</dt>
          <dd className="untrusted">{transaction.billRefNumber ?? '—'}</dd>
        </div>
      </dl>
      {transaction.status !== 'verified' ? (
        <p className="error">Not verified with Safaricom yet, so it cannot be matched.</p>
      ) : items.length === 0 ? (
        <p>No open expected payment fits. Add it under Expected payments, or close this exception with a note.</p>
      ) : (
        <ul className="records" aria-label="Candidates">
          {items.map((s) => (
            <SuggestionRow key={s.expectedPayment.id} transactionId={transactionId} version={transaction.version} suggestion={s} onDone={onDone} />
          ))}
        </ul>
      )}
      <div>
        <button type="button" className="btn" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function SuggestionRow({
  transactionId,
  version,
  suggestion,
  onDone,
}: {
  transactionId: string
  version: number
  suggestion: Suggestion
  onDone: () => void
}) {
  const refresh = useRefreshRecords()
  const [message, setMessage] = useState<Message | null>(null)
  const e = suggestion.expectedPayment
  const due = { minor: (BigInt(e.amountDue.minor) - BigInt(e.amountPaid.minor)).toString() }
  const confirm = useMutation(
    orpc.matches.confirm.mutationOptions({
      onSuccess: () => {
        refresh()
        onDone()
      },
      onError: (error) => {
        let text = 'Could not match the payment.'
        if (isDefinedError(error)) {
          if (error.code === 'STALE_STATE') text = 'The payment changed since you opened it. Cancel and try again.'
          else if (error.code === 'ALLOCATION_REJECTED') text = 'That amount does not fit what is unallocated or still due.'
          else if (error.code === 'INVALID_STATE') text = `Not possible now: ${humanize(error.data.status).toLowerCase()}.`
        }
        setMessage({ tone: 'error', text })
      },
    }),
  )

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const minor = parseKes(field(new FormData(event.currentTarget), 'amount'))
    if (minor === null || minor === '0') {
      setMessage({ tone: 'error', text: 'Enter an amount in shillings, like 1,250.00.' })
      return
    }
    confirm.mutate({
      transactionId,
      version,
      allocations: [{ expectedPaymentId: e.id, amount: { minor, currency: 'KES' } }],
      idempotencyKey: newIdempotencyKey('match'),
    })
  }

  return (
    <li className="record">
      <div className="record-body">
        <p className="record-title">
          <strong>{e.reference}</strong>
          {e.description ? <span className="quiet"> · {e.description}</span> : null}
        </p>
        <p className="record-meta">
          {formatKes(due)} due{e.dueDate ? ` on ${e.dueDate}` : ''} · {suggestion.reasons.map((r) => REASONS[r]).join(', ')}
        </p>
        <FormMessage message={message} />
      </div>
      <form className="form-row" onSubmit={onSubmit}>
        <label className="field">
          <span>Amount (KES)</span>
          <input name="amount" inputMode="decimal" defaultValue={formatAmount(suggestion.amount)} aria-label={`Amount for ${e.reference}`} />
        </label>
        <button type="submit" className="btn btn-primary" disabled={confirm.isPending} aria-busy={confirm.isPending}>
          Allocate
        </button>
      </form>
    </li>
  )
}
