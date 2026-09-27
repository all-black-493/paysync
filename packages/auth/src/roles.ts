export type RoleName = 'viewer' | 'clerk' | 'accountant' | 'admin' | 'owner'

export const ROLE_NAMES: readonly RoleName[] = ['viewer', 'clerk', 'accountant', 'admin', 'owner']
export const APPROVER_ROLES: readonly RoleName[] = ['accountant', 'admin', 'owner']

export function isRoleName(value: string): value is RoleName {
  return (ROLE_NAMES as readonly string[]).includes(value)
}

/** Better Auth stores several roles comma-separated. Unknown names are dropped. */
export function parseRoles(memberRole: string): RoleName[] {
  return memberRole
    .split(',')
    .map((r) => r.trim())
    .filter(isRoleName)
}
