import type { ReactNode } from 'react'

export type Fact = readonly [label: string, value: ReactNode]

/** A ruled key/value list; rows with no value are left out. */
export function Facts({ items, label }: { items: readonly Fact[]; label?: string }) {
  const shown = items.filter(([, value]) => value !== null && value !== undefined && value !== '')
  return (
    <dl className="changes" aria-label={label}>
      {shown.map(([name, value]) => (
        <div key={name}>
          <dt>{name}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="detail-section">
      <h3 className="label">{title}</h3>
      {children}
    </section>
  )
}
