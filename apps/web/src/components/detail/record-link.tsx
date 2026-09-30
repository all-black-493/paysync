'use client'

import type { MouseEvent, ReactNode } from 'react'
import { hrefWith, navigate } from '../../lib/url-state'

export type RecordKind = 'transaction' | 'expected' | 'exception' | 'request'

const VIEW: Record<RecordKind, string> = {
  transaction: 'transactions',
  expected: 'expected',
  exception: 'exceptions',
  request: 'approvals',
}

export function openParam(kind: RecordKind, id: string): string {
  return `${kind}:${id}`
}

export function parseOpenParam(value: string | null): { kind: RecordKind; id: string } | null {
  if (!value) return null
  const [kind, id] = value.split(':')
  if (!id || !(kind === 'transaction' || kind === 'expected' || kind === 'exception' || kind === 'request')) return null
  return { kind, id }
}

/**
 * A real link to a record's detail panel. `stretch` makes the whole row its hit
 * area while buttons inside the row stay clickable.
 */
export function RecordLink({
  kind,
  id,
  stretch = false,
  className,
  children,
}: {
  kind: RecordKind
  id: string
  stretch?: boolean
  className?: string
  children: ReactNode
}) {
  const view = VIEW[kind]
  const params = { view: view === 'exceptions' ? null : view, open: openParam(kind, id) }

  function onClick(event: MouseEvent<HTMLAnchorElement>) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
    event.preventDefault()
    navigate(params)
  }

  return (
    <a href={hrefWith(params)} onClick={onClick} className={[stretch ? 'record-link stretched' : 'record-link', className].filter(Boolean).join(' ')}>
      {children}
    </a>
  )
}
