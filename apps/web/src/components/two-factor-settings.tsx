'use client'

import { useState, type SubmitEvent } from 'react'
import { authClient } from '../lib/auth-client'
import { field } from '../lib/format'
import { TwoFactorCodeForm } from './two-factor-code'

function secretOf(totpUri: string): string {
  return new URL(totpUri).searchParams.get('secret') ?? ''
}

/** Turning on TOTP two-factor authentication; approvers need it to approve. */
export function TwoFactorSettings() {
  const session = authClient.useSession()
  const [uri, setUri] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const enabled = session.data?.user.twoFactorEnabled === true

  async function onEnable(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    const { data, error: enableError } = await authClient.twoFactor.enable({ password: field(new FormData(event.currentTarget), 'password') })
    if (enableError) {
      setError('That password is not right.')
      return
    }
    setUri('totpURI' in data ? data.totpURI : null)
  }

  if (enabled) {
    return (
      <section className="card stack">
        <h2>Two-factor authentication</h2>
        <p>On. Signing in asks for a code from your authenticator app.</p>
      </section>
    )
  }

  return (
    <section className="card stack">
      <h2>Two-factor authentication</h2>
      <p className="muted">Off. Accountants, admins and owners need it to approve actions.</p>
      {uri ? (
        <>
          <p>Add this key to your authenticator app, then enter the code it shows.</p>
          <code className="mono secret">{secretOf(uri)}</code>
          <p className="muted small">
            Or open <a href={uri}>this setup link</a> on the phone with the app.
          </p>
          <TwoFactorCodeForm
            onVerified={() => {
              setUri(null)
              void session.refetch()
            }}
          />
        </>
      ) : (
        <form className="inline-form" onSubmit={(e) => void onEnable(e)}>
          <label>
            Your password
            <input name="password" type="password" autoComplete="current-password" required minLength={12} />
          </label>
          <button type="submit">Turn on</button>
          {error ? <span className="error">{error}</span> : null}
        </form>
      )}
    </section>
  )
}
