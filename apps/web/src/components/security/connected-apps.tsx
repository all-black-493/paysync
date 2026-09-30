'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { appIdentity, listConsents, revokeConsent } from '../../lib/oauth-apps'
import { Time } from '../ui/time'

const KEY = ['oauth-consents']

async function connectedApps() {
  const consents = await listConsents()
  return Promise.all(consents.map(async (c) => ({ ...c, app: await appIdentity(c.clientId).catch(() => ({ name: 'Unknown app', source: c.clientId })) })))
}

/** External agents this person let act as them (MCP over OAuth), and the way to cut one off. */
export function ConnectedApps() {
  const queryClient = useQueryClient()
  const apps = useQuery({ queryKey: KEY, queryFn: connectedApps })
  const disconnect = useMutation({ mutationFn: revokeConsent, onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }) })
  const items = apps.data ?? []

  return (
    <section className="section" aria-labelledby="apps-heading">
      <div className="section-head">
        <h2 id="apps-heading">Connected apps</h2>
        <p>Agents you let work in Paysync as you. None of them can approve anything.</p>
      </div>
      {apps.isError ? <p className="error">Could not load connected apps.</p> : null}
      {apps.isSuccess && items.length === 0 ? <p className="quiet">No apps are connected.</p> : null}
      {items.length > 0 ? (
        <table className="ledger">
          <thead>
            <tr>
              <th scope="col">App</th>
              <th scope="col">Can</th>
              <th scope="col">Connected</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.id}>
                <td className="wide" data-label="App">
                  {c.app.name} <span className="quiet mono small">{c.app.source}</span>
                </td>
                <td data-label="Can">{c.scopeList.includes('paysync:write') ? 'Read and file changes' : 'Read'}</td>
                <td data-label="Connected">
                  <Time iso={c.createdAt.toISOString()} />
                </td>
                <td className="row-actions">
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={disconnect.isPending}
                    onClick={() => {
                      disconnect.mutate(c.id)
                    }}
                  >
                    Disconnect
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  )
}
