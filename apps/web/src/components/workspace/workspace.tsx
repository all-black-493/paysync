'use client'

import type { MeOutput } from '@paysync/contract'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { orpc } from '../../lib/orpc'
import { permissionsFrom } from '../../lib/permissions'
import { useUrlParam } from '../../lib/url-state'
import { ApprovalsPanel } from '../approvals/approvals-panel'
import { DetailDrawer, type DetailPermissions } from '../detail/detail-drawer'
import { ExceptionsPanel } from '../exceptions/exceptions-panel'
import { ExpectedPanel } from '../expected/expected-panel'
import { SecurityPanel } from '../security/security-panel'
import { SettingsPanel } from '../settings/settings-panel'
import { TransactionsPanel } from '../transactions/transactions-panel'
import { Tabs, tabIds, type TabItem } from '../ui/tabs'
import { Console, dailySummaryQuery } from './console'
import { Masthead } from './masthead'

const VIEWS = ['exceptions', 'approvals', 'expected', 'transactions', 'security', 'settings'] as const
type View = (typeof VIEWS)[number]

export function Workspace({ me }: { me: MeOutput }) {
  const permix = useMemo(() => permissionsFrom(me.permissions), [me.permissions])
  // Custom roles can leave out whole areas; show only what this person may read.
  const visible: Record<View, boolean> = {
    exceptions: permix.check('exception.read'),
    approvals: permix.check('pendingAction.read'),
    expected: permix.check('expectedPayment.read'),
    transactions: permix.check('transaction.read'),
    security: true,
    settings: permix.check('apiKey.read'),
  }
  const seesTotals = permix.check('report.read')
  const [requested, setView] = useUrlParam<View>('view', VIEWS, 'exceptions')

  const summary = useQuery({ ...dailySummaryQuery(), enabled: seesTotals })
  const waiting = useQuery({ ...orpc.pendingActions.list.queryOptions({ input: { status: 'pending' } }), enabled: visible.approvals })

  const tabs = (
    [
      { id: 'exceptions', label: 'Exceptions', count: summary.data?.openExceptions },
      { id: 'approvals', label: 'Approvals', count: waiting.data?.items.length },
      { id: 'expected', label: 'Expected payments' },
      { id: 'transactions', label: 'Transactions' },
      { id: 'security', label: 'Security' },
      { id: 'settings', label: 'Settings' },
    ] satisfies ReadonlyArray<TabItem<View>>
  ).filter((t) => visible[t.id])
  const view: View = visible[requested] ? requested : (tabs[0]?.id ?? 'security')
  const ids = tabIds(view)
  const can: DetailPermissions = {
    exceptions: { annotate: permix.check('exception.annotate'), resolve: permix.check('exception.resolve'), confirm: permix.check('match.confirm') },
    transactions: { writeOff: permix.check('transaction.writeOff'), reverse: permix.check('reversal.request'), unmatch: permix.check('match.unmatch') },
    voidExpected: permix.check('expectedPayment.void'),
  }
  const viewer = { id: me.actor.id, email: me.actor.email ?? '', canApprove: permix.check('approval.approve') }

  return (
    <>
      <div className="field-band">
        <div className="field-inner">
          <Masthead me={me} />
          {seesTotals ? <Console /> : null}
        </div>
      </div>
      <nav className="tabs" aria-label="Workspace">
        <div className="page">
          <Tabs items={tabs} current={view} onChange={setView} label="Workspace sections" />
        </div>
      </nav>
      <main className="page panel" id={ids.panel} role="tabpanel" aria-labelledby={ids.tab} tabIndex={-1}>
        {view === 'exceptions' ? (
          <ExceptionsPanel can={can.exceptions} />
        ) : null}
        {view === 'approvals' ? (
          <ApprovalsPanel viewer={viewer} />
        ) : null}
        {view === 'expected' ? <ExpectedPanel canWrite={permix.check('expectedPayment.create')} canVoid={can.voidExpected} /> : null}
        {view === 'transactions' ? (
          <TransactionsPanel can={can.transactions} />
        ) : null}
        {view === 'security' ? <SecurityPanel /> : null}
        {view === 'settings' ? <SettingsPanel viewerId={me.actor.id} /> : null}
      </main>
      <DetailDrawer can={can} viewer={viewer} />
    </>
  )
}
