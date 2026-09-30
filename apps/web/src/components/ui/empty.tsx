import type { ReactNode } from 'react'

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children ? <p>{children}</p> : null}
    </div>
  )
}

export function Loading({ label }: { label: string }) {
  return (
    <p className="quiet" role="status">
      {label}
    </p>
  )
}

export function LoadError({ what }: { what: string }) {
  return (
    <p className="error" role="alert">
      Could not load {what}. Reload the page to try again.
    </p>
  )
}
