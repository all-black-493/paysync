'use client'

import type { RoleName } from '@paysync/auth'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type SubmitEvent } from 'react'
import { authClient } from '../lib/auth-client'
import { field, formatDateTime, newIdempotencyKey } from '../lib/format'
import { orpc } from '../lib/orpc'

const INVITABLE_ROLES: readonly RoleName[] = ['viewer', 'clerk', 'accountant', 'admin']

export function SettingsPanel() {
  return (
    <div className="stack">
      <TeamSection />
      <ApiKeysSection />
    </div>
  )
}

function isRole(value: string): value is RoleName {
  return (INVITABLE_ROLES as readonly string[]).includes(value)
}

function TeamSection() {
  const [message, setMessage] = useState<string | null>(null)
  const [link, setLink] = useState<string | null>(null)
  const invitations = useQuery({
    queryKey: ['invitations'],
    queryFn: async () => (await authClient.organization.listInvitations()).data ?? [],
  })

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    const role = field(form, 'role')
    if (!isRole(role)) return
    const { data, error } = await authClient.organization.inviteMember({ email: field(form, 'email'), role })
    if (error) {
      setMessage(error.message ?? 'Could not create the invitation.')
      return
    }
    formElement.reset()
    setMessage('Invitation created. Send this link to the person you invited:')
    setLink(`${window.location.origin}/accept-invitation/?id=${data.id}`)
    await invitations.refetch()
  }

  return (
    <section className="card stack">
      <h2>Team</h2>
      <p className="muted">Sign-up is by invitation only. Invitations expire after 48 hours.</p>
      <form className="inline-form" onSubmit={(e) => void onSubmit(e)}>
        <label>
          Email
          <input name="email" type="email" required />
        </label>
        <label>
          Role
          <select name="role" defaultValue="clerk">
            {INVITABLE_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Invite</button>
      </form>
      {message ? <p className="muted">{message}</p> : null}
      {link ? <code className="secret">{link}</code> : null}
      {(invitations.data ?? [])
        .filter((i) => i.status === 'pending')
        .map((i) => (
          <div key={i.id} className="row-main small">
            <span>{i.email}</span>
            <span className="badge">{i.role}</span>
            <span className="muted">expires {formatDateTime(new Date(i.expiresAt).toISOString())}</span>
          </div>
        ))}
    </section>
  )
}

function ApiKeysSection() {
  const queryClient = useQueryClient()
  const [secret, setSecret] = useState<string | null>(null)
  const keys = useQuery(orpc.apiKeys.list.queryOptions())
  const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.apiKeys.key() })
  const create = useMutation(
    orpc.apiKeys.create.mutationOptions({
      onSuccess: (data) => {
        setSecret(data.result.key)
        void refresh()
      },
    }),
  )
  const revoke = useMutation(orpc.apiKeys.revoke.mutationOptions({ onSuccess: () => void refresh() }))

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const scope = field(form, 'scope') === 'write' ? 'write' : 'read'
    create.mutate({ name: field(form, 'name'), scope, idempotencyKey: newIdempotencyKey('api-key') })
  }

  return (
    <section className="card stack">
      <h2>Integrator API keys</h2>
      <p className="muted">
        For systems that call the REST API with an <code>x-api-key</code> header. Keys can read, and with the write scope
        create expected payments and annotate exceptions. They can never approve, void, write off or move money.
      </p>
      <form className="inline-form" onSubmit={onSubmit}>
        <label>
          Name
          <input name="name" required minLength={3} maxLength={64} placeholder="Billing system" />
        </label>
        <label>
          Scope
          <select name="scope" defaultValue="read">
            <option value="read">read</option>
            <option value="write">write</option>
          </select>
        </label>
        <button type="submit" disabled={create.isPending}>
          Create key
        </button>
      </form>
      {secret ? (
        <div className="stack">
          <p className="error">Copy this key now. It will not be shown again.</p>
          <code className="secret">{secret}</code>
        </div>
      ) : null}
      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Scope</th>
            <th>Key</th>
            <th>Expires</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(keys.data?.items ?? []).map((k) => (
            <tr key={k.id}>
              <td>{k.name}</td>
              <td>{k.scope ?? '—'}</td>
              <td className="mono">{k.start ? `${k.start}…` : '—'}</td>
              <td>{k.expiresAt ? formatDateTime(k.expiresAt) : 'never'}</td>
              <td>{k.enabled ? 'active' : 'revoked'}</td>
              <td>
                {k.enabled ? (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      revoke.mutate({ id: k.id, idempotencyKey: newIdempotencyKey('revoke') })
                    }}
                  >
                    Revoke
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
