'use client'

import { useEffect, useRef } from 'react'
import { navigate, useSearchParam } from '../../lib/url-state'
import type { Viewer } from '../approvals/request-card'
import type { ExceptionPermissions } from '../exceptions/exception-work'
import type { TransactionPermissions } from '../transactions/transaction-actions'
import { ExceptionDetail } from './exception-detail'
import { ExpectedDetail } from './expected-detail'
import { parseOpenParam, type RecordKind } from './record-link'
import { RequestDetail } from './request-detail'
import { TransactionDetail } from './transaction-detail'

export interface DetailPermissions {
  readonly exceptions: ExceptionPermissions
  readonly transactions: TransactionPermissions
  readonly voidExpected: boolean
}

const TITLES: Record<RecordKind, string> = {
  transaction: 'Payment',
  expected: 'Expected payment',
  exception: 'Exception',
  request: 'Request',
}

/** The record named in `?open=kind:id`, in a side panel (full screen on phones). */
export function DetailDrawer({ can, viewer }: { can: DetailPermissions; viewer: Viewer }) {
  const open = parseOpenParam(useSearchParam('open'))
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  function onClose() {
    if (new URLSearchParams(window.location.search).has('open')) navigate({ open: null }, 'replace')
  }

  return (
    <dialog
      ref={ref}
      className="drawer"
      aria-labelledby="drawer-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) ref.current?.close()
      }}
    >
      {open ? (
        <div className="drawer-inner">
          <header className="drawer-head">
            <h2 id="drawer-title" className="label">
              {TITLES[open.kind]}
            </h2>
            <button type="button" className="btn btn-icon" aria-label="Close panel" onClick={() => ref.current?.close()}>
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
                <path d="M2 2l10 10M12 2 2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
              </svg>
            </button>
          </header>
          <div className="drawer-body" key={`${open.kind}:${open.id}`}>
            {open.kind === 'transaction' ? <TransactionDetail id={open.id} can={can.transactions} /> : null}
            {open.kind === 'expected' ? <ExpectedDetail id={open.id} canVoid={can.voidExpected} /> : null}
            {open.kind === 'exception' ? <ExceptionDetail id={open.id} can={can.exceptions} /> : null}
            {open.kind === 'request' ? <RequestDetail id={open.id} viewer={viewer} /> : null}
          </div>
        </div>
      ) : null}
    </dialog>
  )
}
