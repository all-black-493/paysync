'use client'

import type { ExceptionOutput } from '@paysync/contract'
import { isDefinedError } from '@orpc/client'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type SubmitEvent } from 'react'
import { field, formatDateTime, newIdempotencyKey } from '../lib/format'
import { orpc } from '../lib/orpc'

export function ExceptionsPanel({ canWrite }: { canWrite: boolean }) {
  const list = useQuery(orpc.exceptions.list.queryOptions({ input: {} }))
  if (list.isPending) return <p className="muted">Loading exceptions…</p>
  if (list.isError) return <p className="error">Could not load exceptions.</p>
  if (list.data.items.length === 0) return <p className="muted">No open exceptions. Everything is reconciled.</p>
  return (
    <ul className="list">
      {list.data.items.map((item) => (
        <ExceptionRow key={item.id} item={item} canWrite={canWrite} />
      ))}
    </ul>
  )
}

function ExceptionRow({ item, canWrite }: { item: ExceptionOutput; canWrite: boolean }) {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const annotate = useMutation(
    orpc.exceptions.annotate.mutationOptions({
      onSuccess: () => {
        setEditing(false)
        setMessage(null)
        void queryClient.invalidateQueries({ queryKey: orpc.exceptions.key() })
      },
      onError: (error) => {
        setMessage(
          isDefinedError(error) && error.code === 'STALE_STATE'
            ? 'Someone else changed this exception. Reload and try again.'
            : 'Could not save the note.',
        )
      },
    }),
  )

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const note = field(form, 'note').trim()
    annotate.mutate({ id: item.id, version: item.version, note: note === '' ? null : note, idempotencyKey: newIdempotencyKey('note') })
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
      {canWrite && !editing ? (
        <button type="button" className="secondary" onClick={() => {
            setEditing(true)
          }}>
          {item.note ? 'Edit note' : 'Add note'}
        </button>
      ) : null}
      {editing ? (
        <form className="inline-form" onSubmit={onSubmit}>
          <textarea name="note" defaultValue={item.note ?? ''} maxLength={2000} rows={2} />
          <button type="submit" disabled={annotate.isPending}>
            Save
          </button>
          <button type="button" className="secondary" onClick={() => {
              setEditing(false)
            }}>
            Cancel
          </button>
          {message ? <span className="error">{message}</span> : null}
        </form>
      ) : null}
    </li>
  )
}
