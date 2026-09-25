'use client'

import { useState, type SubmitEvent } from 'react'
import { authClient } from '../../lib/auth-client'
import { field } from '../../lib/format'

export default function SignInPage() {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setPending(true)
    setError(null)
    const { error: signInError } = await authClient.signIn.email({
      email: field(form, 'email'),
      password: field(form, 'password'),
    })
    setPending(false)
    if (signInError) {
      setError(signInError.status === 429 ? 'Too many attempts. Wait a moment and try again.' : 'Email or password is wrong.')
      return
    }
    // Full navigation so the home page starts with a fresh session store.
    const next = new URLSearchParams(window.location.search).get('next') ?? '/'
    window.location.assign(next.startsWith('/') && !next.startsWith('//') ? next : '/')
  }

  return (
    <main className="auth">
      <form className="card auth-card" onSubmit={(e) => void onSubmit(e)}>
        <h1>Paysync</h1>
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
    </main>
  )
}
