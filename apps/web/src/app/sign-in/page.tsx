'use client'

import { useState, type SubmitEvent } from 'react'
import { EntryLayout } from '../../components/entry/entry-layout'
import { TwoFactorCodeForm } from '../../components/entry/two-factor-code'
import { FormMessage, type Message } from '../../components/ui/form-message'
import { authClient, inOAuthFlow, needsSecondFactor } from '../../lib/auth-client'
import { field } from '../../lib/format'

function goNext() {
  // Connecting an app: Better Auth answers the sign-in with the next step of the authorization and the client follows it.
  if (inOAuthFlow) return
  // Full navigation so the home page starts with a fresh session store.
  const next = new URLSearchParams(window.location.search).get('next') ?? '/'
  window.location.assign(next.startsWith('/') && !next.startsWith('//') ? next : '/')
}

export default function SignInPage() {
  const [message, setMessage] = useState<Message | null>(null)
  const [pending, setPending] = useState(false)
  const [step, setStep] = useState<'password' | 'code'>('password')

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setPending(true)
    setMessage(null)
    const { data, error } = await authClient.signIn.email({ email: field(form, 'email'), password: field(form, 'password') })
    setPending(false)
    if (error) {
      setMessage({ tone: 'error', text: error.status === 429 ? 'Too many attempts. Wait a moment and try again.' : 'Email or password is wrong.' })
      return
    }
    if (needsSecondFactor(data)) {
      setStep('code')
      return
    }
    goNext()
  }

  return (
    <EntryLayout>
      <div className="entry-form">
        <h2>{step === 'code' ? 'Enter your code' : 'Sign in'}</h2>
        {step === 'code' ? (
          <TwoFactorCodeForm onVerified={goNext} />
        ) : (
          <form className="stack" onSubmit={(e) => void onSubmit(e)}>
            <label className="field">
              <span>Email</span>
              <input name="email" type="email" autoComplete="username" required />
            </label>
            <label className="field">
              <span>Password</span>
              <input name="password" type="password" autoComplete="current-password" required minLength={12} />
            </label>
            <button type="submit" className="btn btn-primary btn-block" disabled={pending} aria-busy={pending}>
              {pending ? 'Signing in…' : 'Sign in'}
            </button>
            <FormMessage message={message} />
          </form>
        )}
      </div>
    </EntryLayout>
  )
}
