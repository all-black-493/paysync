'use client'

import { useEffect, useState } from 'react'
import { EntryLayout } from '../../components/entry/entry-layout'
import { FormMessage, type Message } from '../../components/ui/form-message'
import { authClient } from '../../lib/auth-client'
import { SCOPE_TEXT, appIdentity, type AppIdentity } from '../../lib/oauth-apps'

function requested(): { clientId: string; scopes: string[] } {
  const query = new URLSearchParams(window.location.search)
  const asked = new Set((query.get('scope') ?? '').split(' '))
  return { clientId: query.get('client_id') ?? '', scopes: Object.keys(SCOPE_TEXT).filter((s) => asked.has(s)) }
}

/** Where a person lets an external agent (MCP client) act as them in their active organization. */
export default function ConsentPage() {
  const session = authClient.useSession()
  const org = authClient.useActiveOrganization()
  const [app, setApp] = useState<AppIdentity | null>(null)
  const [message, setMessage] = useState<Message | null>(null)
  const [pending, setPending] = useState(false)
  const [scopes, setScopes] = useState<string[]>([])

  useEffect(() => {
    const request = requested()
    setScopes(request.scopes)
    void appIdentity(request.clientId).then(setApp, () => {
      setMessage({ tone: 'error', text: 'This app is not known to Paysync.' })
    })
  }, [])

  async function decide(accept: boolean) {
    setPending(true)
    setMessage(null)
    // On success Better Auth answers with the app's redirect, which the client follows.
    const { error } = await authClient.$fetch('/oauth2/consent', { method: 'POST', body: { accept } })
    if (error) {
      setPending(false)
      setMessage({ tone: 'error', text: error.message ?? 'Could not complete the connection. Start again from the app.' })
    }
  }

  if (session.isPending || org.isPending) return <main className="loading-screen">Loading…</main>

  return (
    <EntryLayout>
      <div className="entry-form">
        <h2>Connect {app?.name ?? 'this app'}?</h2>
        <p className="lead">
          {app ? <span className="mono">{app.source}</span> : null} wants to work in <strong>{org.data?.name ?? 'your organization'}</strong> as{' '}
          {session.data?.user.name ?? 'you'}, with your role.
        </p>
        <ul className="scope-list">
          {scopes.map((s) => (
            <li key={s}>{SCOPE_TEXT[s]}</li>
          ))}
        </ul>
        <p className="quiet small">It can never approve anything. You can disconnect it under Security.</p>
        <div className="actions">
          <button type="button" className="btn" disabled={pending} onClick={() => void decide(false)}>
            Deny
          </button>
          <button type="button" className="btn btn-primary" disabled={pending || !app || !org.data} aria-busy={pending} onClick={() => void decide(true)}>
            Allow
          </button>
        </div>
        <FormMessage message={message} />
      </div>
    </EntryLayout>
  )
}
