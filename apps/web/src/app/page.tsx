'use client'

import type { MeOutput } from '@paysync/contract'
import { ORPCError } from '@orpc/client'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { ApprovalsPanel } from '../components/approvals'
import { DailySummary } from '../components/daily-summary'
import { ExceptionsPanel } from '../components/exceptions'
import { ExpectedPanel } from '../components/expected'
import { OrgPicker } from '../components/org-picker'
import { SettingsPanel } from '../components/settings'
import { TransactionsPanel } from '../components/transactions'
import { TwoFactorSettings } from '../components/two-factor-settings'
import { authClient } from '../lib/auth-client'
import { orpc } from '../lib/orpc'
import { permissionsFrom } from '../lib/permissions'

type Tab = 'exceptions' | 'approvals' | 'expected' | 'transactions' | 'security' | 'settings'

export default function HomePage() {
  const router = useRouter()
  const session = authClient.useSession()

  useEffect(() => {
    if (!session.isPending && !session.data) router.replace('/sign-in/')
  }, [session.isPending, session.data, router])

  if (session.isPending || !session.data) return <main className="shell muted">Loading…</main>
  return <Workspace />
}

function Workspace() {
  const me = useQuery(orpc.me.get.queryOptions())
  const noActiveOrg = me.error instanceof ORPCError && me.error.code === 'FORBIDDEN'

  if (me.isPending) return <main className="shell muted">Loading…</main>
  if (noActiveOrg) return <OrgPicker />
  if (me.isError) return <main className="shell error">Could not load your workspace.</main>
  return <Dashboard me={me.data} />
}

function Dashboard({ me }: { me: MeOutput }) {
  const [tab, setTab] = useState<Tab>('exceptions')
  const router = useRouter()
  const queryClient = useQueryClient()
  const permix = useMemo(() => permissionsFrom(me.permissions), [me.permissions])
  const tabs: ReadonlyArray<readonly [Tab, string]> = [
    ['exceptions', 'Exceptions'],
    ['approvals', 'Approvals'],
    ['expected', 'Expected payments'],
    ['transactions', 'Transactions'],
    ['security', 'Security'],
    ...(permix.check('apiKey.read') ? ([['settings', 'Settings']] as const) : []),
  ]

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <strong>{me.organization.name}</strong>
          <span className="muted">
            {' '}
            · {me.actor.name} · {me.role}
          </span>
        </div>
        <div className="topbar-actions">
          <button
            type="button"
            className="secondary"
            onClick={() =>
              void authClient.organization.setActive({ organizationId: null }).then(() => queryClient.invalidateQueries())
            }
          >
            Switch organization
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              void authClient.signOut().then(() => {
                router.replace('/sign-in/')
              })
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      <DailySummary />

      <nav className="tabs" aria-label="Sections">
        {tabs.map(([t, label]) => (
          <button
            key={t}
            type="button"
            className={t === tab ? 'tab active' : 'tab'}
            onClick={() => {
              setTab(t)
            }}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === 'exceptions' ? (
        <ExceptionsPanel
          can={{
            annotate: permix.check('exception.annotate'),
            resolve: permix.check('exception.resolve'),
            confirm: permix.check('match.confirm'),
          }}
        />
      ) : null}
      {tab === 'approvals' ? (
        <ApprovalsPanel viewer={{ id: me.actor.id, email: me.actor.email ?? '', canApprove: permix.check('approval.approve') }} />
      ) : null}
      {tab === 'expected' ? <ExpectedPanel canWrite={permix.check('expectedPayment.create')} canVoid={permix.check('expectedPayment.void')} /> : null}
      {tab === 'transactions' ? (
        <TransactionsPanel
          can={{ writeOff: permix.check('transaction.writeOff'), reverse: permix.check('reversal.request'), unmatch: permix.check('match.unmatch') }}
        />
      ) : null}
      {tab === 'security' ? <TwoFactorSettings /> : null}
      {tab === 'settings' && permix.check('apiKey.read') ? <SettingsPanel /> : null}
    </div>
  )
}
