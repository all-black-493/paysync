'use client'

import { useRef, type KeyboardEvent } from 'react'

export interface TabItem<T extends string> {
  readonly id: T
  readonly label: string
  readonly count?: number | undefined
}

export function tabIds(id: string) {
  return { tab: `tab-${id}`, panel: `panel-${id}` }
}

/** WAI-ARIA tabs with arrow-key movement; activation follows focus. */
export function Tabs<T extends string>({
  items,
  current,
  onChange,
  label,
}: {
  items: ReadonlyArray<TabItem<T>>
  current: T
  onChange: (id: T) => void
  label: string
}) {
  const refs = useRef(new Map<T, HTMLButtonElement>())

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = items.length - 1
    const next =
      event.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
      : event.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
      : event.key === 'Home' ? 0
      : event.key === 'End' ? last
      : null
    if (next === null) return
    event.preventDefault()
    const item = items[next]
    if (!item) return
    onChange(item.id)
    refs.current.get(item.id)?.focus()
  }

  return (
    <div className="tab-list" role="tablist" aria-label={label}>
      {items.map((item, index) => {
        const selected = item.id === current
        const ids = tabIds(item.id)
        return (
          <button
            key={item.id}
            ref={(el) => {
              if (el) refs.current.set(item.id, el)
              else refs.current.delete(item.id)
            }}
            id={ids.tab}
            type="button"
            role="tab"
            className="tab"
            aria-selected={selected}
            aria-controls={ids.panel}
            tabIndex={selected ? 0 : -1}
            onClick={() => {
              onChange(item.id)
            }}
            onKeyDown={(e) => {
              onKeyDown(e, index)
            }}
          >
            {item.label}
            {item.count ? <span className="count">{item.count}</span> : null}
          </button>
        )
      })}
    </div>
  )
}
