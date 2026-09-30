'use client'

import { useEffect, useState, type SubmitEvent } from 'react'
import { EntryLayout } from '../../components/entry/entry-layout'
import { FormMessage, type Message } from '../../components/ui/form-message'
import { authClient } from '../../lib/auth-client'
import { field } from '../../lib/format'

function invitationId(): string {
  return new URLSearchParams(window.location.search).get('id') ?? ''
}

async function acceptAndEnter(id: string): Promise<Message | null> {
  const { data, error } = await authClient.organization.acceptInvitation({ invitationId: id })
  if (error) return { tone: 'error', text: error.message ?? 'This invitation is not valid for your account.' }
  await authClient.organization.setActive({ organizationId: data.invitation.organizationId })
  window.location.assign('/')
  return null
}

export default function AcceptInvitationPage() {
  const session = authClient.useSession()
  const [message, setMessage] = useState<Message | null>(null)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (session.data) void acceptAndEnter(invitationId()).then(setMessage)
  }, [session.data])

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setPending(true)
    const { error } = await authClient.signUp.email({ name: field(form, 'name'), email: field(form, 'email'), password: field(form, 'password') })
    setPending(false)
    if (error) {
      setMessage({ tone: 'error', text: error.status === 403 ? 'Use the email address the invitation was sent to.' : 'Could not create your account.' })
      return
    }
    setMessage(await acceptAndEnter(invitationId()))
  }

  if (session.isPending) return <main className="loading-screen">Loading…</main>
  if (session.data) {
    return (
      <EntryLayout>
        <div className="entry-form">
          <h2>Joining…</h2>
          <FormMessage message={message} />
        </div>
      </EntryLayout>
    )
  }

  const signInLink = `/sign-in/?next=${encodeURIComponent(window.location.pathname + window.location.search)}`
  return (
    <EntryLayout>
      <form className="entry-form" onSubmit={(e) => void onSubmit(e)}>
        <h2>Join your team</h2>
        <p className="lead">
          Already have an account? <a href={signInLink}>Sign in</a> first.
        </p>
        <label className="field">
          <span>Name</span>
          <input name="name" required maxLength={80} autoComplete="name" />
        </label>
        <label className="field">
          <span>Invited email</span>
          <input name="email" type="email" required autoComplete="username" />
        </label>
        <label className="field">
          <span>Password (12+ characters)</span>
          <input name="password" type="password" required minLength={12} autoComplete="new-password" />
        </label>
        <button type="submit" className="btn btn-primary btn-block" disabled={pending} aria-busy={pending}>
          {pending ? 'Creating account…' : 'Create account'}
        </button>
        <FormMessage message={message} />
      </form>
    </EntryLayout>
  )
}
