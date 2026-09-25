'use client'

import { useEffect, useState, type SubmitEvent } from 'react'
import { authClient } from '../../lib/auth-client'
import { field } from '../../lib/format'

function invitationId(): string {
  return new URLSearchParams(window.location.search).get('id') ?? ''
}

async function acceptAndEnter(id: string): Promise<string | null> {
  const { data, error } = await authClient.organization.acceptInvitation({ invitationId: id })
  if (error) return error.message ?? 'This invitation is not valid for your account.'
  await authClient.organization.setActive({ organizationId: data.invitation.organizationId })
  window.location.assign('/')
  return null
}

export default function AcceptInvitationPage() {
  const session = authClient.useSession()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (session.data) void acceptAndEnter(invitationId()).then(setError)
  }, [session.data])

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setPending(true)
    const { error: signUpError } = await authClient.signUp.email({
      name: field(form, 'name'),
      email: field(form, 'email'),
      password: field(form, 'password'),
    })
    setPending(false)
    if (signUpError) {
      setError(signUpError.status === 403 ? 'Use the email address the invitation was sent to.' : 'Could not create your account.')
      return
    }
    setError(await acceptAndEnter(invitationId()))
  }

  if (session.isPending) return <main className="auth muted">Loading…</main>
  if (session.data) {
    return <main className="auth">{error ? <p className="error">{error}</p> : <p className="muted">Joining…</p>}</main>
  }
  return (
    <main className="auth">
      <form className="card auth-card" onSubmit={(e) => void onSubmit(e)}>
        <h1>Join Paysync</h1>
        <p className="muted">
          Create your account to accept the invitation. Already have one?{' '}
          <a href={`/sign-in/?next=${encodeURIComponent(window.location.pathname + window.location.search)}`}>Sign in</a>{' '}
          first.
        </p>
        <label>
          Name
          <input name="name" required maxLength={80} autoComplete="name" />
        </label>
        <label>
          Email (the invited address)
          <input name="email" type="email" required autoComplete="username" />
        </label>
        <label>
          Password
          <input name="password" type="password" required minLength={12} autoComplete="new-password" />
        </label>
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" disabled={pending}>
          {pending ? 'Creating account…' : 'Create account and join'}
        </button>
      </form>
    </main>
  )
}
