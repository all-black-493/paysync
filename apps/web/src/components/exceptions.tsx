'use client'

import type { ExceptionOutput, MatchSuggestionsOutput } from '@paysync/contract'
import { isDefinedError } from '@orpc/client'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type SubmitEvent } from 'react'
import { field, formatDateTime, formatKes, newIdempotencyKey, parseKes } from '../lib/format'
import { orpc } from '../lib/orpc'

export interface ExceptionPermissions {
  readonly annotate: boolean
  readonly resolve: boolean
  readonly confirm: boolean
}

type Mode = 'idle' | 'note' | 'match' | 'close'

/** Exceptions a person settles by matching the payment; the others need a different action. */
const MATCHABLE = new Set<ExceptionOutput['kind']>(['no_match', 'low_confidence', 'duplicate', 'partial_payment', 'overpayment'])

export function ExceptionsPanel({ can }: { can: ExceptionPermissions }) {
  const list = useQuery(orpc.exceptions.list.queryOptions({ input: {} }))
  if (list.isPending) return <p className="muted">Loading exceptions…</p>
  if (list.isError) return <p className="error">Could not load exceptions.</p>
  if (list.data.items.length === 0) return <p className="muted">No open exceptions. Everything is reconciled.</p>
  return (
    <ul className="list">
      {list.data.items.map((item) => (
        <ExceptionRow key={item.id} item={item} can={can} />
      ))}
    </ul>
  )
}

function useRefreshAll() {
  const queryClient = useQueryClient()
  return () => {
    for (const key of [orpc.exceptions.key(), orpc.transactions.key(), orpc.expected.key(), orpc.matches.key(), orpc.reports.key()]) {
      void queryClient.invalidateQueries({ queryKey: key })
    }
  }
}

function ExceptionRow({ item, can }: { item: ExceptionOutput; can: ExceptionPermissions }) {
  const [mode, setMode] = useState<Mode>('idle')
  const done = () => {
    setMode('idle')
  }
  return (
    <li className="card row">
      <div className="row-main">
        <span className={`badge ${item.priority}`}>{item.kind.replaceAll('_', ' ')}</span>
        <div>
          <div>{item.summary}</div>
          <div className="muted small">
            Opened {formatDateTime(item.createdAt)}
            {item.tags.length > 0 ? ` · ${item.tags.join(', ')}` : ''}
          </div>
          {item.note ? <p className="note">{item.note}</p> : null}
        </div>
      </div>
      {mode === 'idle' ? (
        <div className="actions">
          {can.confirm && item.transactionId && MATCHABLE.has(item.kind) ? (
            <button type="button" onClick={() => {
                setMode('match')
              }}>
              Match payment
            </button>
          ) : null}
          {can.annotate ? (
            <button type="button" className="secondary" onClick={() => {
                setMode('note')
              }}>
              {item.note ? 'Edit note' : 'Add note'}
            </button>
          ) : null}
          {can.resolve ? (
            <button type="button" className="secondary" onClick={() => {
                setMode('close')
              }}>
              Close
            </button>
          ) : null}
        </div>
      ) : null}
      {mode === 'note' ? <NoteForm item={item} onDone={done} /> : null}
      {mode === 'close' ? <CloseForm item={item} onDone={done} /> : null}
      {mode === 'match' && item.transactionId ? <MatchPanel transactionId={item.transactionId} onDone={done} /> : null}
    </li>
  )
}

function NoteForm({ item, onDone }: { item: ExceptionOutput; onDone: () => void }) {
  const refresh = useRefreshAll()
  const [message, setMessage] = useState<string | null>(null)
  const annotate = useMutation(
    orpc.exceptions.annotate.mutationOptions({
      onSuccess: () => {
        refresh()
        onDone()
      },
      onError: (error) => {
        setMessage(isDefinedError(error) && error.code === 'STALE_STATE' ? 'Someone else changed this exception. Reload and try again.' : 'Could not save the note.')
      },
    }),
  )
  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const note = field(new FormData(event.currentTarget), 'note').trim()
    annotate.mutate({ id: item.id, version: item.version, note: note === '' ? null : note, idempotencyKey: newIdempotencyKey('note') })
  }
  return (
    <form className="inline-form" onSubmit={onSubmit}>
      <textarea name="note" aria-label="Note" defaultValue={item.note ?? ''} maxLength={2000} rows={2} />
      <button type="submit" disabled={annotate.isPending}>
        Save
      </button>
      <button type="button" className="secondary" onClick={onDone}>
        Cancel
      </button>
      {message ? <span className="error">{message}</span> : null}
    </form>
  )
}

function CloseForm({ item, onDone }: { item: ExceptionOutput; onDone: () => void }) {
  const refresh = useRefreshAll()
  const [message, setMessage] = useState<string | null>(null)
  const resolve = useMutation(
    orpc.exceptions.resolve.mutationOptions({
      onSuccess: () => {
        refresh()
        onDone()
      },
      onError: (error) => {
        setMessage(isDefinedError(error) && error.code === 'STALE_STATE' ? 'Someone else changed this exception. Reload and try again.' : 'Could not close the exception.')
      },
    }),
  )
  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const resolution = field(form, 'resolution') === 'dismissed' ? 'dismissed' : 'resolved'
    resolve.mutate({ id: item.id, version: item.version, resolution, note: field(form, 'note').trim(), idempotencyKey: newIdempotencyKey('resolve') })
  }
  return (
    <form className="inline-form" onSubmit={onSubmit}>
      <select name="resolution" aria-label="Outcome" defaultValue="resolved">
        <option value="resolved">Resolved</option>
        <option value="dismissed">Dismissed (nothing to do)</option>
      </select>
      <textarea name="note" aria-label="Why" placeholder="Why is it closed?" required maxLength={2000} rows={2} />
      <button type="submit" disabled={resolve.isPending}>
        Close exception
      </button>
      <button type="button" className="secondary" onClick={onDone}>
        Cancel
      </button>
      {message ? <span className="error">{message}</span> : null}
    </form>
  )
}

const REASONS: Record<MatchSuggestionsOutput['suggestions'][number]['reasons'][number], string> = {
  same_reference: 'same reference',
  same_reference_normalized: 'same reference, written differently',
  similar_reference: 'similar reference',
  amount_equals_due: 'amount equals what is due',
  amount_below_due: 'part of what is due',
  due_date_near: 'due around the payment date',
}

function MatchPanel({ transactionId, onDone }: { transactionId: string; onDone: () => void }) {
  const suggestions = useQuery(orpc.matches.suggest.queryOptions({ input: { transactionId } }))
  if (suggestions.isPending) return <p className="muted">Looking for expected payments…</p>
  if (suggestions.isError) return <p className="error">Could not load suggestions.</p>
  const { transaction, suggestions: items } = suggestions.data
  return (
    <div className="stack match-panel">
      <div className="small">
        Payment <strong>{transaction.receiptNumber}</strong> of {formatKes(transaction.amount)}, {formatKes(transaction.unallocated)} unallocated.
        Reference typed by the payer: <span className="untrusted">{transaction.billRefNumber ?? '(none)'}</span>
      </div>
      {transaction.status !== 'verified' ? (
        <p className="error small">This payment is not verified with Safaricom yet, so it cannot be matched.</p>
      ) : items.length === 0 ? (
        <p className="muted small">No open expected payment looks like this one. Create the expected payment first, or close the exception with a note.</p>
      ) : (
        <ul className="list">
          {items.map((s) => (
            <SuggestionRow key={s.expectedPayment.id} transactionId={transactionId} version={transaction.version} suggestion={s} onDone={onDone} />
          ))}
        </ul>
      )}
      <div>
        <button type="button" className="secondary" onClick={onDone}>
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
  suggestion: MatchSuggestionsOutput['suggestions'][number]
  onDone: () => void
}) {
  const refresh = useRefreshAll()
  const [message, setMessage] = useState<string | null>(null)
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
          else if (error.code === 'INVALID_STATE') text = `Not possible now (${error.data.status.replaceAll('_', ' ')}).`
        }
        setMessage(text)
      },
    }),
  )
  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const minor = parseKes(field(new FormData(event.currentTarget), 'amount'))
    if (minor === null || minor === '0') {
      setMessage('Enter an amount in shillings, e.g. 1,250.00')
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
    <li className="card row">
      <div>
        <strong>{e.reference}</strong> {e.description ? <span className="muted">· {e.description}</span> : null}
        <div className="muted small">
          {formatKes(due)} still due{e.dueDate ? ` · due ${e.dueDate}` : ''} · {suggestion.reasons.map((r) => REASONS[r]).join(', ')}
        </div>
      </div>
      <form className="inline-form" onSubmit={onSubmit}>
        <label className="small">
          Amount (KES)
          <input name="amount" inputMode="decimal" defaultValue={formatKes(suggestion.amount).replace('KES ', '')} aria-label={`Amount for ${e.reference}`} />
        </label>
        <button type="submit" disabled={confirm.isPending}>
          Allocate to {e.reference}
        </button>
        {message ? <span className="error">{message}</span> : null}
      </form>
    </li>
  )
}
