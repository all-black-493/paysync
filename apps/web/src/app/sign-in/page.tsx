'use client'

import { useState, type SubmitEvent } from 'react'
import { TwoFactorCodeForm } from '../../components/two-factor-code'
import { authClient, needsSecondFactor } from '../../lib/auth-client'
import { field } from '../../lib/format'

function goNext() {
  // Full navigation so the home page starts with a fresh session store.
  const next = new URLSearchParams(window.location.search).get('next') ?? '/'
  window.location.assign(next.startsWith('/') && !next.startsWith('//') ? next : '/')
}

export default function SignInPage() {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [step, setStep] = useState<'password' | 'code'>('password')

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setPending(true)
    setError(null)
    const { data, error: signInError } = await authClient.signIn.email({
      email: field(form, 'email'),
      password: field(form, 'password'),
    })
    setPending(false)
    if (signInError) {
      setError(signInError.status === 429 ? 'Too many attempts. Wait a moment and try again.' : 'Email or password is wrong.')
      return
    }
    if (needsSecondFactor(data)) {
      setStep('code')
      return
    }
    goNext()
  }

  return (
    <main className="auth">
      <div className="card auth-card">
        <h1>Paysync</h1>
        {step === 'code' ? (
          <>
            <p className="muted">Two-factor authentication is on for this account.</p>
            <TwoFactorCodeForm onVerified={goNext} />
          </>
        ) : (
          <form className="stack" onSubmit={(e) => void onSubmit(e)}>
            <p className="muted">Sign in to your reconciliation workspace.</p>
            <label>
              Email
              <input name="email" type="email" autoComplete="username" required />
            </label>
            <label>
              Password
              <input name="password" type="password" autoComplete="current-password" required minLength={12} />
            </label>
            {error ? (
              <p className="error" role="alert">
                {error}
              </p>
            ) : null}
            <button type="submit" disabled={pending}>
              {pending ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        )}
      </div>
    </main>
  )
}
