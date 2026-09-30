'use client'

import { PERMISSION_CATALOG } from '@paysync/auth'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { authClient } from '../../lib/auth-client'
import { BUILT_IN_ROLES, roleLabel } from '../../lib/labels'
import { LoadError } from '../ui/empty'
import { FormMessage, type Message } from '../ui/form-message'
import { RoleForm } from './role-form'
import { ROLES_KEY, useCustomRoles, type CustomRole } from './use-roles'

const LABEL = new Map(PERMISSION_CATALOG.map((p) => [p.permission, p.label]))

export function RolesSection() {
  const roles = useCustomRoles()
  const [editing, setEditing] = useState<CustomRole | 'new' | null>(null)

  return (
    <section className="section" aria-labelledby="roles-heading">
      <div className="section-head">
        <h2 id="roles-heading">Roles</h2>
        <p>Build roles from the permissions below. Team, role and key management stay with owners and admins.</p>
      </div>
      <div className="stack-lg">
        <table className="ledger">
          <thead>
            <tr>
              <th scope="col">Role</th>
              <th scope="col">Can</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {BUILT_IN_ROLES.map(([name, description]) => (
              <tr key={name}>
                <td data-label="Role">
                  {roleLabel(name)} <span className="label">Built in</span>
                </td>
                <td className="wide" data-label="Can">
                  {description}
                </td>
                <td />
              </tr>
            ))}
            {(roles.data ?? []).map((role) => (
              <CustomRoleRow key={role.id} role={role} onEdit={() => { setEditing(role) }} />
            ))}
          </tbody>
        </table>
        {roles.isError ? <LoadError what="custom roles" /> : null}
        {editing === null ? (
          <div>
            <button type="button" className="btn btn-primary" onClick={() => { setEditing('new') }}>
              New role
            </button>
          </div>
        ) : (
          <RoleForm key={editing === 'new' ? 'new' : editing.id} role={editing === 'new' ? undefined : editing} onDone={() => { setEditing(null) }} />
        )}
      </div>
    </section>
  )
}

function CustomRoleRow({ role, onEdit }: { role: CustomRole; onEdit: () => void }) {
  const queryClient = useQueryClient()
  const [message, setMessage] = useState<Message | null>(null)

  async function remove() {
    if (!window.confirm(`Delete the ${roleLabel(role.name)} role?`)) return
    const { error } = await authClient.organization.deleteRole({ roleId: role.id })
    if (error) {
      const inUse = error.code === 'ROLE_IS_ASSIGNED_TO_MEMBERS'
      setMessage({ tone: 'error', text: inUse ? 'Someone still holds this role. Give them another role first.' : (error.message ?? 'Could not delete the role.') })
      return
    }
    await queryClient.invalidateQueries({ queryKey: ROLES_KEY })
  }

  return (
    <tr>
      <td data-label="Role">{roleLabel(role.name)}</td>
      <td className="wide" data-label="Can">
        {role.permissions.map((p) => LABEL.get(p) ?? p).join(', ')}
        <FormMessage message={message} />
      </td>
      <td className="row-actions">
        <div className="actions">
          <button type="button" className="btn" onClick={onEdit}>
            Edit
          </button>
          <button type="button" className="btn btn-danger" onClick={() => void remove()}>
            Delete
          </button>
        </div>
      </td>
    </tr>
  )
}
