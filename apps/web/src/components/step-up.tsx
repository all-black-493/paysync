'use client'

import { useState, type SubmitEvent } from 'react'
import { authClient, needsSecondFactor } from '../lib/auth-client'
import { field } from '../lib/format'
import { TwoFactorCodeForm } from './two-factor-code'

/**
 * Approving needs a recent sign-in (§6C.4): sign in again in place, password
 * then code, and carry on with a fresh session.
 */
export function StepUp({ email, onDone }: { email: string; onDone: () => void }) {
  const [step, setStep] = useState<'password' | 'code'>('password')
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    const { data, error: signInError } = await authClient.signIn.email({ email, password: field(new FormData(event.currentTarget), 'password') })
    if (signInError) {
      setError('That password is not right.')
      return
    }
    if (needsSecondFactor(data)) setStep('code')
    else onDone()
  }

  return (
    <div className="card stack step-up">
      <strong>Confirm it is you</strong>
      <p className="muted small">Approving needs a sign-in from the last few minutes.</p>
      {step === 'code' ? (
        <TwoFactorCodeForm onVerified={onDone} />
      ) : (
        <form className="stack" onSubmit={(e) => void onSubmit(e)}>
          <label>
            Password for {email}
            <input name="password" type="password" autoComplete="current-password" required minLength={12} autoFocus />
          </label>
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}
          <button type="submit">Continue</button>
        </form>
      )}
    </div>
  )
}
