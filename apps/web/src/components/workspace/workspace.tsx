'use client'

import type { MeOutput } from '@paysync/contract'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { orpc } from '../../lib/orpc'
import { permissionsFrom } from '../../lib/permissions'
import { useUrlParam } from '../../lib/url-state'
import { ApprovalsPanel } from '../approvals/approvals-panel'
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
  const canSettings = permix.check('apiKey.read')
  const [requested, setView] = useUrlParam<View>('view', VIEWS, 'exceptions')
  const view = requested === 'settings' && !canSettings ? 'exceptions' : requested

  const summary = useQuery(dailySummaryQuery())
  const waiting = useQuery(orpc.pendingActions.list.queryOptions({ input: { status: 'pending' } }))

  const tabs: ReadonlyArray<TabItem<View>> = [
    { id: 'exceptions', label: 'Exceptions', count: summary.data?.openExceptions },
    { id: 'approvals', label: 'Approvals', count: waiting.data?.items.length },
    { id: 'expected', label: 'Expected payments' },
    { id: 'transactions', label: 'Transactions' },
    { id: 'security', label: 'Security' },
    ...(canSettings ? [{ id: 'settings' as const, label: 'Settings' }] : []),
  ]
  const ids = tabIds(view)

  return (
    <>
      <div className="field-band">
        <div className="field-inner">
          <Masthead me={me} />
          <Console />
        </div>
      </div>
      <nav className="tabs" aria-label="Workspace">
        <div className="page">
          <Tabs items={tabs} current={view} onChange={setView} label="Workspace sections" />
        </div>
      </nav>
      <main className="page panel" id={ids.panel} role="tabpanel" aria-labelledby={ids.tab} tabIndex={-1}>
        {view === 'exceptions' ? (
          <ExceptionsPanel
            can={{
              annotate: permix.check('exception.annotate'),
              resolve: permix.check('exception.resolve'),
              confirm: permix.check('match.confirm'),
            }}
          />
        ) : null}
        {view === 'approvals' ? (
          <ApprovalsPanel viewer={{ id: me.actor.id, email: me.actor.email ?? '', canApprove: permix.check('approval.approve') }} />
        ) : null}
        {view === 'expected' ? <ExpectedPanel canWrite={permix.check('expectedPayment.create')} canVoid={permix.check('expectedPayment.void')} /> : null}
        {view === 'transactions' ? (
          <TransactionsPanel
            can={{ writeOff: permix.check('transaction.writeOff'), reverse: permix.check('reversal.request'), unmatch: permix.check('match.unmatch') }}
          />
        ) : null}
        {view === 'security' ? <SecurityPanel /> : null}
        {view === 'settings' ? <SettingsPanel /> : null}
      </main>
    </>
  )
}
