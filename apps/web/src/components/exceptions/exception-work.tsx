'use client'

import type { ExceptionOutput } from '@paysync/contract'
import { useState } from 'react'
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

/** The actions on one open exception and the task each opens: shared by the queue row and the detail panel. */
export function ExceptionWork({ item, can }: { item: ExceptionOutput; can: ExceptionPermissions }) {
  const [mode, setMode] = useState<Mode>('idle')
  const done = () => {
    setMode('idle')
  }
  if (item.status !== 'open') return null
  const canMatch = can.confirm && item.transactionId !== null && MATCHABLE.has(item.kind)

  return (
    <>
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
    </>
  )
}
