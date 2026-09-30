'use client'

import { BUILT_IN_ROLES, roleLabel } from '../../lib/labels'
import { useCustomRoles } from './use-roles'

/** Every role a person can be given here: built-in ones except owner, then the organization's own. */
export function RoleOptions() {
  const custom = useCustomRoles()
  return (
    <>
      <optgroup label="Built in">
        {BUILT_IN_ROLES.filter(([name]) => name !== 'owner').map(([name]) => (
          <option key={name} value={name}>
            {roleLabel(name)}
          </option>
        ))}
      </optgroup>
      {custom.data && custom.data.length > 0 ? (
        <optgroup label="This organization">
          {custom.data.map((r) => (
            <option key={r.id} value={r.name}>
              {roleLabel(r.name)}
            </option>
          ))}
        </optgroup>
      ) : null}
    </>
  )
}
