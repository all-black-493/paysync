'use client'

import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { authClient } from '../../lib/auth-client'
import { roleLabel } from '../../lib/labels'
import { LoadError, Loading } from '../ui/empty'
import { FormMessage, type Message } from '../ui/form-message'
import { RoleOptions } from './role-options'

const MEMBERS_KEY = ['organization-members'] as const

export function MembersSection({ viewerId }: { viewerId: string }) {
  const members = useQuery({
    queryKey: MEMBERS_KEY,
    queryFn: async () => {
      const { data, error } = await authClient.organization.listMembers()
      if (error) throw new Error(error.message ?? 'Could not load members')
      return data.members
    },
  })

  return (
    <section className="section" aria-labelledby="members-heading">
      <div className="section-head">
        <h2 id="members-heading">Members</h2>
        <p>Nobody can change their own role.</p>
      </div>
      {members.isPending ? <Loading label="Loading members…" /> : null}
      {members.isError ? <LoadError what="members" /> : null}
      {members.data ? (
        <table className="ledger">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Email</th>
              <th scope="col">Role</th>
            </tr>
          </thead>
          <tbody>
            {members.data.map((m) => (
              <tr key={m.id}>
                <td data-label="Name">{m.user.name}</td>
                <td className="wide" data-label="Email">
                  {m.user.email}
                </td>
                <td data-label="Role">
                  {m.userId === viewerId || m.role === 'owner' ? (
                    <span>{roleLabel(m.role)}</span>
                  ) : (
                    <MemberRole memberId={m.id} name={m.user.name} role={m.role} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  )
}

function MemberRole({ memberId, name, role }: { memberId: string; name: string; role: string }) {
  const [message, setMessage] = useState<Message | null>(null)
  const [value, setValue] = useState(role)

  async function change(next: string) {
    setMessage(null)
    setValue(next)
    const { error } = await authClient.organization.updateMemberRole({ memberId, role: next })
    if (error) {
      setValue(role)
      setMessage({ tone: 'error', text: error.message ?? 'Could not change the role.' })
      return
    }
    setMessage({ tone: 'info', text: 'Saved.' })
  }

  return (
    <div className="stack">
      <select aria-label={`Role for ${name}`} value={value} onChange={(e) => void change(e.target.value)}>
        <RoleOptions />
      </select>
      <FormMessage message={message} />
    </div>
  )
}
