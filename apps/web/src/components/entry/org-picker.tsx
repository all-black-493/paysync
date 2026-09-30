'use client'

import { useQueryClient } from '@tanstack/react-query'
import { authClient } from '../../lib/auth-client'
import { EntryLayout } from './entry-layout'

export function OrgPicker() {
  const orgs = authClient.useListOrganizations()
  const queryClient = useQueryClient()
  return (
    <EntryLayout>
      <div className="entry-form">
        <h2>Choose an organization</h2>
        {orgs.isPending ? <p className="quiet">Loading…</p> : null}
        {orgs.data?.length === 0 ? <p className="quiet">You are not a member of any organization yet. Ask an admin for an invitation.</p> : null}
        {orgs.data && orgs.data.length > 0 ? (
          <div className="choice-list">
            {orgs.data.map((org) => (
              <button
                key={org.id}
                type="button"
                onClick={() => void authClient.organization.setActive({ organizationId: org.id }).then(() => queryClient.invalidateQueries())}
              >
                {org.name}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </EntryLayout>
  )
}
