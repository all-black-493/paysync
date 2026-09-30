'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type SubmitEvent } from 'react'
import { field, newIdempotencyKey } from '../../lib/format'
import { orpc } from '../../lib/orpc'
import { Status } from '../ui/status'
import { Time } from '../ui/time'

export function ApiKeysSection() {
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

  const items = keys.data?.items ?? []

  return (
    <section className="section" aria-labelledby="keys-heading">
      <div className="section-head">
        <h2 id="keys-heading">API keys</h2>
        <p>
          For systems calling the REST API with <code>x-api-key</code>. Keys never approve, void, write off or move money.
        </p>
      </div>
      <div className="stack-lg">
        <form className="workbench" onSubmit={onSubmit} aria-label="Create an API key">
          <div className="form-row">
            <label className="field field-wide">
              <span>Name</span>
              <input name="name" required minLength={3} maxLength={64} placeholder="Billing system" />
            </label>
            <label className="field">
              <span>Scope</span>
              <select name="scope" defaultValue="read">
                <option value="read">Read</option>
                <option value="write">Read and write</option>
              </select>
            </label>
            <button type="submit" className="btn btn-primary" disabled={create.isPending} aria-busy={create.isPending}>
              Create key
            </button>
          </div>
          {secret ? (
            <div className="stack" role="status">
              <strong>Copy this key now. It is shown only once.</strong>
              <code className="secret">{secret}</code>
            </div>
          ) : null}
        </form>
        {items.length > 0 ? (
          <table className="ledger">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Scope</th>
                <th scope="col">Key</th>
                <th scope="col">Expires</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((k) => (
                <tr key={k.id}>
                  <td className="wide" data-label="Name">
                    {k.name}
                  </td>
                  <td data-label="Scope">{k.scope === 'write' ? 'Read and write' : k.scope === 'read' ? 'Read' : '—'}</td>
                  <td className="mono" data-label="Key">
                    {k.start ? `${k.start}…` : '—'}
                  </td>
                  <td data-label="Expires">{k.expiresAt ? <Time iso={k.expiresAt} /> : 'Never'}</td>
                  <td data-label="Status">
                    <Status status={k.enabled ? { label: 'Active', tone: 'ok' } : { label: 'Revoked', tone: 'muted' }} />
                  </td>
                  <td className="row-actions">
                    {k.enabled ? (
                      <button
                        type="button"
                        className="btn btn-danger"
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
        ) : null}
      </div>
    </section>
  )
}
