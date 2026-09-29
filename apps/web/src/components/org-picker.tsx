'use client'

import { useQueryClient } from '@tanstack/react-query'
import { authClient } from '../lib/auth-client'

export function OrgPicker() {
  const orgs = authClient.useListOrganizations()
  const queryClient = useQueryClient()
  return (
    <main className="auth">
      <div className="card auth-card">
        <h1>Choose an organization</h1>
        {orgs.isPending ? <p className="muted">Loading…</p> : null}
        {(orgs.data ?? []).map((org) => (
          <button
            key={org.id}
            type="button"
            onClick={() =>
              void authClient.organization.setActive({ organizationId: org.id }).then(() => queryClient.invalidateQueries())
            }
          >
            {org.name}
          </button>
        ))}
        {orgs.data?.length === 0 ? <p className="muted">You are not a member of any organization yet.</p> : null}
      </div>
    </main>
  )
}
