export type RoleName = 'viewer' | 'clerk' | 'accountant' | 'admin' | 'owner'

export const ROLE_NAMES: readonly RoleName[] = ['viewer', 'clerk', 'accountant', 'admin', 'owner']

/** Built-in roles that manage the team, custom roles and API keys. */
export const MANAGER_ROLES: readonly RoleName[] = ['admin', 'owner']

export function isRoleName(value: string): value is RoleName {
  return (ROLE_NAMES as readonly string[]).includes(value)
}

/** Better Auth stores several roles comma-separated. */
export function parseRoleList(memberRole: string): string[] {
  return memberRole
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean)
}

/** Built-in roles only. */
export function parseRoles(memberRole: string): RoleName[] {
  return parseRoleList(memberRole).filter(isRoleName)
}

/** Custom role names: letters, digits, spaces and hyphens; never a built-in name. */
export const CUSTOM_ROLE_NAME = /^[A-Za-z][A-Za-z0-9 -]{1,38}[A-Za-z0-9]$/

export function isValidCustomRoleName(name: string): boolean {
  return CUSTOM_ROLE_NAME.test(name) && !isRoleName(name.toLowerCase())
}
