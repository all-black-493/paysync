'use client'

import type { ExceptionOutput } from '@paysync/contract'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { exceptionStatus } from '../../lib/labels'
import { orpc } from '../../lib/orpc'
import { Empty, LoadError, Loading } from '../ui/empty'
import { Status } from '../ui/status'
import { Time } from '../ui/time'
import { CloseForm, NoteForm } from './exception-forms'
import { MatchPanel } from './match-panel'

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
  if (list.isPending) return <Loading label="Loading exceptions…" />
  if (list.isError) return <LoadError what="exceptions" />
  if (list.data.items.length === 0) {
    return <Empty title="Everything is reconciled.">New payments that cannot be matched with confidence will wait here.</Empty>
  }
  return (
    <ul className="records" aria-label="Open exceptions">
      {list.data.items.map((item) => (
        <ExceptionRow key={item.id} item={item} can={can} />
      ))}
    </ul>
  )
}

function ExceptionRow({ item, can }: { item: ExceptionOutput; can: ExceptionPermissions }) {
  const [mode, setMode] = useState<Mode>('idle')
  const done = () => {
    setMode('idle')
  }
  const canMatch = can.confirm && item.transactionId !== null && MATCHABLE.has(item.kind)

  return (
    <li className="record">
      <div className="record-kind">
        <Status status={exceptionStatus(item)} />
      </div>
      <div className="record-body">
        <p className="record-title">{item.summary}</p>
        <p className="record-meta">
          Opened <Time iso={item.createdAt} />
          {item.tags.length > 0 ? ` · ${item.tags.join(', ')}` : ''}
        </p>
        {item.note ? (
          <p className="record-note">
            <span className="label">Note</span>
            {item.note}
          </p>
        ) : null}
      </div>
      {mode === 'idle' ? (
        <div className="actions">
          {canMatch ? (
            <button type="button" className="btn" onClick={() => { setMode('match') }}>
              Match
            </button>
          ) : null}
          {can.annotate ? (
            <button type="button" className="btn" onClick={() => { setMode('note') }}>
              {item.note ? 'Edit note' : 'Note'}
            </button>
          ) : null}
          {can.resolve ? (
            <button type="button" className="btn" onClick={() => { setMode('close') }}>
              Close
            </button>
          ) : null}
        </div>
      ) : (
        <span />
      )}
      {mode !== 'idle' ? (
        <div className="record-work reveal">
          {mode === 'note' ? <NoteForm item={item} onDone={done} /> : null}
          {mode === 'close' ? <CloseForm item={item} onDone={done} /> : null}
          {mode === 'match' && item.transactionId ? <MatchPanel transactionId={item.transactionId} onDone={done} /> : null}
        </div>
      ) : null}
    </li>
  )
}
