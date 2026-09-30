import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import '../styles/tokens.css'
import '../styles/ai-elements.css'
import '../styles/base.css'
import '../styles/controls.css'
import '../styles/frame.css'
import '../styles/ledger.css'
import '../styles/approvals.css'
import '../styles/detail.css'
import { era, season, uncut } from './fonts'
import { Providers } from './providers'

export const metadata: Metadata = {
  title: 'Paysync',
  description: 'M-Pesa reconciliation',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${uncut.variable} ${season.variable} ${era.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
