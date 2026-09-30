'use client'

import { useState, type SubmitEvent } from 'react'
import { authClient } from '../../lib/auth-client'
import { field } from '../../lib/format'
import { TwoFactorCodeForm } from '../entry/two-factor-code'
import { FormMessage, type Message } from '../ui/form-message'
import { Status } from '../ui/status'

function secretOf(totpUri: string): string {
  return new URL(totpUri).searchParams.get('secret') ?? ''
}

/** TOTP two-factor authentication; approvers need it to decide requests. */
export function SecurityPanel() {
  const session = authClient.useSession()
  const [uri, setUri] = useState<string | null>(null)
  const [message, setMessage] = useState<Message | null>(null)
  const enabled = session.data?.user.twoFactorEnabled === true

  async function onEnable(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    setMessage(null)
    const { data, error } = await authClient.twoFactor.enable({ password: field(new FormData(event.currentTarget), 'password') })
    if (error) {
      setMessage({ tone: 'error', text: 'That password is not right.' })
      return
    }
    setUri('totpURI' in data ? data.totpURI : null)
  }

  return (
    <section className="section" aria-labelledby="two-factor-heading">
      <div className="section-head">
        <h2 id="two-factor-heading">Two-factor authentication</h2>
        <Status status={enabled ? { label: 'On', tone: 'ok' } : { label: 'Off', tone: 'neutral' }} />
      </div>
      {enabled ? (
        <p>Signing in asks for a code from your authenticator app.</p>
      ) : uri ? (
        <div className="stack narrow">
          <p>Add this key to your authenticator app, then enter the code it shows.</p>
          <code className="secret">{secretOf(uri)}</code>
          <p className="quiet small">
            On the phone with the app, <a href={uri}>open the setup link</a> instead.
          </p>
          <TwoFactorCodeForm
            submitLabel="Turn on"
            onVerified={() => {
              setUri(null)
              void session.refetch()
            }}
          />
        </div>
      ) : (
        <form className="stack narrow" onSubmit={(e) => void onEnable(e)}>
          <p className="quiet">Required to approve requests.</p>
          <label className="field">
            <span>Your password</span>
            <input name="password" type="password" autoComplete="current-password" required minLength={12} />
          </label>
          <div>
            <button type="submit" className="btn btn-primary">
              Set up
            </button>
          </div>
          <FormMessage message={message} />
        </form>
      )}
    </section>
  )
}
