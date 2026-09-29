'use client'

import { useQuery } from '@tanstack/react-query'
import { formatKes, todayInNairobi } from '../lib/format'
import { orpc } from '../lib/orpc'

export function DailySummary() {
  const date = todayInNairobi()
  const summary = useQuery(orpc.reports.dailySummary.queryOptions({ input: { date } }))
  if (!summary.data) return <section className="stats muted">Loading today’s totals…</section>
  const s = summary.data
  return (
    <section className="stats" aria-label={`Totals for ${date}`}>
      <Stat label="Received today" value={formatKes(s.received.amount)} hint={`${s.received.count} payments`} />
      <Stat label="Matched" value={formatKes(s.matched.amount)} hint={`${s.matched.count} fully matched`} />
      <Stat label="Unmatched" value={formatKes(s.unmatched.amount)} hint={`${s.unmatched.count} need attention`} />
      <Stat label="Open exceptions" value={String(s.openExceptions)} hint="in the queue" />
    </section>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="card stat">
      <div className="muted">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="muted small">{hint}</div>
    </div>
  )
}
