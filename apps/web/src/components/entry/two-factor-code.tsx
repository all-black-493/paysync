'use client'

import { useState, type SubmitEvent } from 'react'
import { authClient } from '../../lib/auth-client'
import { field } from '../../lib/format'
import { FormMessage, type Message } from '../ui/form-message'

/** The TOTP step of a sign-in: first sign-in, or confirming before a decision. */
export function TwoFactorCodeForm({ onVerified, submitLabel = 'Verify' }: { onVerified: () => void; submitLabel?: string }) {
  const [message, setMessage] = useState<Message | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setMessage(null)
    const { error } = await authClient.twoFactor.verifyTotp({ code: field(new FormData(event.currentTarget), 'code').trim() })
    setPending(false)
    if (error) {
      setMessage({ tone: 'error', text: error.status === 429 ? 'Too many attempts. Wait a moment.' : 'That code is not right. Use the current one.' })
      return
    }
    onVerified()
  }

  return (
    <form className="stack" onSubmit={(e) => void onSubmit(e)}>
      <label className="field">
        <span>Authenticator code</span>
        <input
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          autoFocus
          aria-invalid={message?.tone === 'error'}
        />
      </label>
      <button type="submit" className="btn btn-primary btn-block" disabled={pending} aria-busy={pending}>
        {pending ? 'Checking…' : submitLabel}
      </button>
      <FormMessage message={message} />
    </form>
  )
}
