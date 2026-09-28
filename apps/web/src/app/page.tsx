'use client'

import { ORPCError } from '@orpc/client'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { ExceptionsPanel } from '../components/exceptions'
import { ExpectedPanel } from '../components/expected'
import { SettingsPanel } from '../components/settings'
import { TransactionsPanel } from '../components/transactions'
import { authClient } from '../lib/auth-client'
import { formatKes, todayInNairobi } from '../lib/format'
import { orpc } from '../lib/orpc'
import { permissionsFrom } from '../lib/permissions'

type Tab = 'exceptions' | 'expected' | 'transactions' | 'settings'

const TABS: ReadonlyArray<readonly [Tab, string]> = [
  ['exceptions', 'Exceptions'],
  ['expected', 'Expected payments'],
  ['transactions', 'Transactions'],
]


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
  return (
    <Dashboard
      role={me.data.role}
      orgName={me.data.organization.name}
      userName={me.data.actor.name}
      permissions={me.data.permissions}
    />
  )
}

function OrgPicker() {
  const orgs = authClient.useListOrganizations()
  const queryClient = useQueryClient()
  return (
    <main className="auth">
      <div className="card auth-card">
        <h1>Choose an organization</h1>
        {orgs.isPending ? <p className="muted">Loading…</p> : null}
        {(orgs.data ?? []).map((org) => (
          <button
            key={org.id}
            type="button"
            onClick={() =>
              void authClient.organization.setActive({ organizationId: org.id }).then(() => queryClient.invalidateQueries())
            }
          >
            {org.name}
          </button>
        ))}
        {orgs.data?.length === 0 ? <p className="muted">You are not a member of any organization yet.</p> : null}
      </div>
    </main>
  )
}

function Dashboard({
  role,
  orgName,
  userName,
  permissions,
}: {
  role: string
  orgName: string
  userName: string
  permissions: Parameters<typeof permissionsFrom>[0]
}) {
  const [tab, setTab] = useState<Tab>('exceptions')
  const router = useRouter()
  const queryClient = useQueryClient()
  const permix = useMemo(() => permissionsFrom(permissions), [permissions])
  const canSettings = permix.check('apiKey.read')
  const tabs: ReadonlyArray<readonly [Tab, string]> = canSettings ? [...TABS, ['settings', 'Settings']] : TABS

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <strong>{orgName}</strong>
          <span className="muted">
            {' '}
            · {userName} · {role}
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

      <Summary />

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
      {tab === 'expected' ? <ExpectedPanel canWrite={permix.check('expectedPayment.create')} /> : null}
      {tab === 'transactions' ? <TransactionsPanel /> : null}
      {tab === 'settings' && canSettings ? <SettingsPanel /> : null}
    </div>
  )
}

function Summary() {
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
