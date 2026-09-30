'use client'

import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { formatAmount, todayInNairobi } from '../../lib/format'
import { orpc } from '../../lib/orpc'

export function dailySummaryQuery() {
  return orpc.reports.dailySummary.queryOptions({ input: { date: todayInNairobi() } })
}

/** Today's position (East Africa day) in the navy console strip. */
export function Console() {
  const summary = useQuery(dailySummaryQuery())
  const s = summary.data
  const busy = !s
  return (
    <dl className="console" aria-label="Today">
      <Cell label="Received today" busy={busy}>
        {s ? <Kes minor={s.received.amount.minor} /> : '—'}
      </Cell>
      <Cell label="Matched" busy={busy}>
        {s ? <Kes minor={s.matched.amount.minor} /> : '—'}
      </Cell>
      <Cell label="Unmatched" busy={busy}>
        {s ? <Kes minor={s.unmatched.amount.minor} /> : '—'}
      </Cell>
      <Cell label="Open exceptions" busy={busy}>
        {s ? s.openExceptions : '—'}
      </Cell>
    </dl>
  )
}

function Cell({ label, busy, children }: { label: string; busy: boolean; children: ReactNode }) {
  return (
    <div className="console-cell" aria-busy={busy}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function Kes({ minor }: { minor: string }) {
  return (
    <>
      <span className="currency">KES</span>
      {formatAmount({ minor })}
    </>
  )
}
