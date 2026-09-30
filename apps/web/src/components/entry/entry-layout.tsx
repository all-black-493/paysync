import type { ReactNode } from 'react'

/** Sign-in, invitations and the organization picker: the navy field beside the form. */
export function EntryLayout({ children }: { children: ReactNode }) {
  return (
    <div className="entry">
      <div className="entry-field">
        <img
          className="entry-photo"
          src="/images/kicc-800.webp"
          srcSet="/images/kicc-800.webp 800w, /images/kicc-1400.webp 1400w"
          sizes="(max-width: 820px) 100vw, 46vw"
          alt=""
          decoding="async"
          fetchPriority="high"
        />
        <span className="wordmark">Paysync</span>
        {/* <p className="entry-line">Every shilling accounted for.</p> */}
      </div>
      <main className="entry-main">{children}</main>
    </div>
  )
}
