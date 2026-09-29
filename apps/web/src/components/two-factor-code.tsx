'use client'

import { useState, type SubmitEvent } from 'react'
import { authClient } from '../lib/auth-client'
import { field } from '../lib/format'

/** The TOTP step of a sign-in (first sign-in or a step-up before approving). */
export function TwoFactorCodeForm({ onVerified }: { onVerified: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError(null)
    const { error: verifyError } = await authClient.twoFactor.verifyTotp({ code: field(new FormData(event.currentTarget), 'code').trim() })
    setPending(false)
    if (verifyError) {
      setError(verifyError.status === 429 ? 'Too many attempts. Wait a moment.' : 'That code is not right. Use the current code from your app.')
      return
    }
    onVerified()
  }

  return (
    <form className="stack" onSubmit={(e) => void onSubmit(e)}>
      <label>
        Code from your authenticator app
        <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required autoFocus />
      </label>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <button type="submit" disabled={pending}>
        {pending ? 'Checking…' : 'Verify'}
      </button>
    </form>
  )
}
