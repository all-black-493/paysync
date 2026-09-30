'use client'

import type { ExceptionOutput } from '@paysync/contract'
import { isDefinedError } from '@orpc/client'
import { useMutation } from '@tanstack/react-query'
import { useState, type SubmitEvent } from 'react'
import { field, newIdempotencyKey } from '../../lib/format'
import { orpc } from '../../lib/orpc'
import { useRefreshRecords } from '../../lib/refresh'
import { FormMessage, type Message } from '../ui/form-message'

const STALE: Message = { tone: 'error', text: 'Someone changed this exception meanwhile. Reload and try again.' }

export function NoteForm({ item, onDone }: { item: ExceptionOutput; onDone: () => void }) {
  const refresh = useRefreshRecords()
  const [message, setMessage] = useState<Message | null>(null)
  const annotate = useMutation(
    orpc.exceptions.annotate.mutationOptions({
      onSuccess: () => {
        refresh()
        onDone()
      },
      onError: (error) => {
        setMessage(isDefinedError(error) && error.code === 'STALE_STATE' ? STALE : { tone: 'error', text: 'Could not save the note.' })
      },
    }),
  )

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const note = field(new FormData(event.currentTarget), 'note').trim()
    annotate.mutate({ id: item.id, version: item.version, note: note === '' ? null : note, idempotencyKey: newIdempotencyKey('note') })
  }

  return (
    <form className="workbench" onSubmit={onSubmit}>
      <label className="field">
        <span>Note</span>
        <textarea name="note" defaultValue={item.note ?? ''} maxLength={2000} rows={3} autoFocus />
      </label>
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={annotate.isPending} aria-busy={annotate.isPending}>
          Save note
        </button>
        <button type="button" className="btn" onClick={onDone}>
          Cancel
        </button>
      </div>
      <FormMessage message={message} />
    </form>
  )
}

export function CloseForm({ item, onDone }: { item: ExceptionOutput; onDone: () => void }) {
  const refresh = useRefreshRecords()
  const [message, setMessage] = useState<Message | null>(null)
  const resolve = useMutation(
    orpc.exceptions.resolve.mutationOptions({
      onSuccess: () => {
        refresh()
        onDone()
      },
      onError: (error) => {
        setMessage(isDefinedError(error) && error.code === 'STALE_STATE' ? STALE : { tone: 'error', text: 'Could not close the exception.' })
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
    <form className="workbench" onSubmit={onSubmit}>
      <div className="form-row">
        <label className="field">
          <span>Outcome</span>
          <select name="resolution" defaultValue="resolved">
            <option value="resolved">Resolved</option>
            <option value="dismissed">Nothing to do</option>
          </select>
        </label>
        <label className="field field-wide">
          <span>Why</span>
          <input name="note" required maxLength={2000} autoFocus />
        </label>
      </div>
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={resolve.isPending} aria-busy={resolve.isPending}>
          Close exception
        </button>
        <button type="button" className="btn" onClick={onDone}>
          Cancel
        </button>
      </div>
      <FormMessage message={message} />
    </form>
  )
}
