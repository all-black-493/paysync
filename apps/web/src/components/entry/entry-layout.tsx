import type { ReactNode } from 'react'

/** Sign-in, invitations and the organization picker: the navy field beside the form. */
export function EntryLayout({ children }: { children: ReactNode }) {
  return (
    <div className="entry">
      <div className="entry-field field-band">
        <span className="wordmark">Paysync</span>
        <p className="entry-line">Every shilling accounted for.</p>
      </div>
      <main className="entry-main">{children}</main>
    </div>
  )
}
