import { createAccessControl, type AccessControl, type Role } from 'better-auth/plugins/access'
import { adminAc, defaultStatements, ownerAc } from 'better-auth/plugins/organization/access'
import type { RoleName } from './roles.js'

// Better Auth only authorizes its own resources (organization, members,
// invitations, API key management). Application permissions live in Permix.
export const statements = {
  ...defaultStatements,
  apiKey: ['create', 'read', 'update', 'delete'],
} as const

// Explicit types keep the declaration emit as Better Auth's aliases, which the
// organization plugin needs to infer our role names across package boundaries.
export const ac: AccessControl<typeof statements> = createAccessControl(statements)

const manageKeys = { apiKey: ['create', 'read', 'update', 'delete'] } as const

export const roles: Record<RoleName, Role> = {
  viewer: ac.newRole({}),
  clerk: ac.newRole({}),
  accountant: ac.newRole({}),
  admin: ac.newRole({ ...adminAc.statements, ...manageKeys }),
  owner: ac.newRole({ ...ownerAc.statements, ...manageKeys }),
}
