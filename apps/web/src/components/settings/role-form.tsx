'use client'

import { PERMISSION_CATALOG, isAppPermission, isValidCustomRoleName, toStatements, type AppPermission } from '@paysync/auth'
import { useQueryClient } from '@tanstack/react-query'
import { useState, type SubmitEvent } from 'react'
import { authClient } from '../../lib/auth-client'
import { field } from '../../lib/format'
import { roleLabel } from '../../lib/labels'
import { FormMessage, type Message } from '../ui/form-message'
import { ROLES_KEY, type CustomRole } from './use-roles'

const GROUPS = [...new Set(PERMISSION_CATALOG.map((p) => p.group))]

/** Create a role, or change an existing role's permissions (names are fixed once people hold them). */
export function RoleForm({ role, onDone }: { role?: CustomRole; onDone: () => void }) {
  const queryClient = useQueryClient()
  const [message, setMessage] = useState<Message | null>(null)
  const [pending, setPending] = useState(false)
  const held = new Set(role?.permissions ?? [])

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const chosen = form.getAll('permission').filter((v): v is AppPermission => typeof v === 'string' && isAppPermission(v))
    if (chosen.length === 0) {
      setMessage({ tone: 'error', text: 'Choose at least one permission.' })
      return
    }
    const name = role?.name ?? field(form, 'name').trim()
    if (!role && !isValidCustomRoleName(name)) {
      setMessage({ tone: 'error', text: 'Use 3 to 40 letters, digits, spaces or hyphens, and not a built-in role name.' })
      return
    }
    setPending(true)
    const permission = toStatements(chosen)
    const { error } = role
      ? await authClient.organization.updateRole({ roleId: role.id, data: { permission } })
      : await authClient.organization.createRole({ role: name, permission })
    setPending(false)
    if (error) {
      setMessage({ tone: 'error', text: error.message ?? 'Could not save the role.' })
      return
    }
    await queryClient.invalidateQueries({ queryKey: ROLES_KEY })
    onDone()
  }

  return (
    <form className="workbench reveal" onSubmit={(e) => void onSubmit(e)} aria-label={role ? `Edit ${roleLabel(role.name)}` : 'New role'}>
      {role ? (
        <p>
          <strong>{roleLabel(role.name)}</strong>
        </p>
      ) : (
        <label className="field narrow">
          <span>Role name</span>
          <input name="name" required maxLength={40} placeholder="Rent collector" autoFocus />
        </label>
      )}
      <div className="permission-groups">
        {GROUPS.map((group) => (
          <fieldset key={group} className="permission-group">
            <legend className="label">{group}</legend>
            {PERMISSION_CATALOG.filter((p) => p.group === group).map((p) => (
              <label key={p.permission} className="check">
                <input type="checkbox" name="permission" value={p.permission} defaultChecked={held.has(p.permission)} />
                <span>
                  {p.label}
                  {p.caution ? <small>{p.caution}</small> : null}
                </span>
              </label>
            ))}
          </fieldset>
        ))}
      </div>
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={pending} aria-busy={pending}>
          {role ? 'Save role' : 'Create role'}
        </button>
        <button type="button" className="btn" onClick={onDone}>
          Cancel
        </button>
      </div>
      <FormMessage message={message} />
    </form>
  )
}
