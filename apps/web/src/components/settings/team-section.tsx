'use client'

import { useQuery } from '@tanstack/react-query'
import { useState, type SubmitEvent } from 'react'
import { authClient } from '../../lib/auth-client'
import { field } from '../../lib/format'
import { FormMessage, type Message } from '../ui/form-message'
import { Time } from '../ui/time'
import { RoleOptions } from './role-options'

export function TeamSection() {
  const [message, setMessage] = useState<Message | null>(null)
  const [link, setLink] = useState<string | null>(null)
  const invitations = useQuery({
    queryKey: ['invitations'],
    queryFn: async () => (await authClient.organization.listInvitations()).data ?? [],
  })
  const pending = (invitations.data ?? []).filter((i) => i.status === 'pending')

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    const role = field(form, 'role')
    const { data, error } = await authClient.organization.inviteMember({ email: field(form, 'email'), role })
    if (error) {
      setMessage({ tone: 'error', text: error.message ?? 'Could not create the invitation.' })
      return
    }
    formElement.reset()
    setMessage({ tone: 'info', text: 'Invitation ready. Send this link to them; it works for 48 hours.' })
    setLink(`${window.location.origin}/accept-invitation/?id=${data.id}`)
    await invitations.refetch()
  }

  return (
    <section className="section" aria-labelledby="team-heading">
      <div className="section-head">
        <h2 id="team-heading">Team</h2>
        <p>Joining is by invitation only.</p>
      </div>
      <div className="stack-lg">
        <form className="workbench" onSubmit={(e) => void onSubmit(e)} aria-label="Invite someone">
          <div className="form-row">
            <label className="field field-wide">
              <span>Email</span>
              <input name="email" type="email" required />
            </label>
            <label className="field">
              <span>Role</span>
              <select name="role" defaultValue="clerk">
                <RoleOptions />
              </select>
            </label>
            <button type="submit" className="btn btn-primary">
              Invite
            </button>
          </div>
          <FormMessage message={message} />
          {link ? <code className="secret">{link}</code> : null}
        </form>
        {pending.length > 0 ? (
          <table className="ledger">
            <thead>
              <tr>
                <th scope="col">Invited</th>
                <th scope="col">Role</th>
                <th scope="col">Expires</th>
              </tr>
            </thead>
            <tbody>
              {pending.map((i) => (
                <tr key={i.id}>
                  <td className="wide" data-label="Invited">
                    {i.email}
                  </td>
                  <td data-label="Role">{i.role}</td>
                  <td data-label="Expires">
                    <Time iso={new Date(i.expiresAt).toISOString()} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </section>
  )
}
