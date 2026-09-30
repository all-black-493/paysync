'use client'

import { useState, type SubmitEvent } from 'react'
import { authClient, needsSecondFactor } from '../../lib/auth-client'
import { field } from '../../lib/format'
import { TwoFactorCodeForm } from '../entry/two-factor-code'
import { FormMessage, type Message } from '../ui/form-message'

/** Deciding needs a sign-in from the last ten minutes: sign in again in place, then carry on. */
export function StepUp({ email, onDone }: { email: string; onDone: () => void }) {
  const [step, setStep] = useState<'password' | 'code'>('password')
  const [message, setMessage] = useState<Message | null>(null)

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    setMessage(null)
    const { data, error } = await authClient.signIn.email({ email, password: field(new FormData(event.currentTarget), 'password') })
    if (error) {
      setMessage({ tone: 'error', text: 'That password is not right.' })
      return
    }
    if (needsSecondFactor(data)) setStep('code')
    else onDone()
  }

  return (
    <div className="step-up reveal">
      <strong>Confirm it is you</strong>
      {step === 'code' ? (
        <TwoFactorCodeForm onVerified={onDone} submitLabel="Confirm" />
      ) : (
        <form className="stack" onSubmit={(e) => void onSubmit(e)}>
          <label className="field">
            <span>Password</span>
            <input name="password" type="password" autoComplete="current-password" required minLength={12} autoFocus />
          </label>
          <button type="submit" className="btn btn-primary btn-block">
            Continue
          </button>
          <FormMessage message={message} />
        </form>
      )}
    </div>
  )
}
