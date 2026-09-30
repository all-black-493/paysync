import { createAccessControl, type AccessControl, type Role } from 'better-auth/plugins/access'
import { adminAc, defaultStatements, ownerAc } from 'better-auth/plugins/organization/access'
import { APP_STATEMENTS, ROLE_GRANTS, toStatements } from './catalog.js'
import type { RoleName } from './roles.js'

// Better Auth knows the application permissions too, so custom roles can hold
// them and its own escalation check applies: nobody grants what they lack.
// Permix remains the enforcement point for application procedures.
export const statements = {
  ...defaultStatements,
  ...APP_STATEMENTS,
  apiKey: ['create', 'read', 'update', 'delete'],
} as const

// Explicit types keep the declaration emit as Better Auth's aliases, which the
// organization plugin needs to infer our role names across package boundaries.
export const ac: AccessControl<typeof statements> = createAccessControl(statements)

const manage = {
  apiKey: ['create', 'read', 'update', 'delete'],
  ac: ['create', 'read', 'update', 'delete'],
} as const

function builtIn(role: RoleName, extra: Record<string, readonly string[]> = {}): Role {
  // The statements are built at runtime from ROLE_GRANTS, so tsc needs the cast; the linter's
  // program resolves Better Auth's input type loosely and calls it unnecessary.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  return ac.newRole({ ...toStatements(ROLE_GRANTS[role]), ...extra } as Parameters<typeof ac.newRole>[0])
}

export const roles: Record<RoleName, Role> = {
  viewer: builtIn('viewer'),
  clerk: builtIn('clerk'),
  accountant: builtIn('accountant'),
  admin: builtIn('admin', { ...adminAc.statements, ...manage }),
  owner: builtIn('owner', { ...ownerAc.statements, ...manage }),
}
