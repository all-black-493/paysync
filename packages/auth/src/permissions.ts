import { createAccessControl, type AccessControl, type Role } from 'better-auth/plugins/access'
import { adminAc, defaultStatements, ownerAc } from 'better-auth/plugins/organization/access'

export const statements = {
  ...defaultStatements,
  transaction: ['read', 'writeOff'],
  expectedPayment: ['read', 'create', 'update', 'void'],
  exception: ['read', 'annotate'],
  match: ['read', 'suggest', 'confirm', 'unmatch'],
  report: ['read'],
  reconciliation: ['run'],
  approval: ['approve'],
  reversal: ['request'],
  apiKey: ['create', 'read', 'update', 'delete'],
} as const

// Explicit types keep the declaration emit as Better Auth's aliases, which the
// organization plugin needs to infer our role names across package boundaries.
export const ac: AccessControl<typeof statements> = createAccessControl(statements)

const readAll = {
  transaction: ['read'],
  expectedPayment: ['read'],
  exception: ['read'],
  match: ['read', 'suggest'],
  report: ['read'],
} as const

const clerkWork = {
  ...readAll,
  expectedPayment: ['read', 'create', 'update', 'void'],
  exception: ['read', 'annotate'],
  match: ['read', 'suggest', 'confirm', 'unmatch'],
  transaction: ['read', 'writeOff'],
  reconciliation: ['run'],
} as const

// Destructive requests from a clerk still go through approval (M5); only approvers may approve.
const approverWork = {
  ...clerkWork,
  approval: ['approve'],
  reversal: ['request'],
} as const

export type RoleName = 'viewer' | 'clerk' | 'accountant' | 'admin' | 'owner'

export const roles: Record<RoleName, Role> = {
  viewer: ac.newRole(readAll),
  clerk: ac.newRole(clerkWork),
  accountant: ac.newRole(approverWork),
  admin: ac.newRole({ ...approverWork, ...adminAc.statements, apiKey: ['create', 'read', 'update', 'delete'] }),
  owner: ac.newRole({ ...approverWork, ...ownerAc.statements, apiKey: ['create', 'read', 'update', 'delete'] }),
}

export const ROLE_NAMES = Object.keys(roles) as RoleName[]
export const APPROVER_ROLES: readonly RoleName[] = ['accountant', 'admin', 'owner']

type Statements = typeof statements
export type Permission = { [R in keyof Statements]?: ReadonlyArray<Statements[R][number]> }

function isRoleName(value: string): value is RoleName {
  return Object.hasOwn(roles, value)
}

/** A member can hold several roles, stored comma-separated by Better Auth. Unknown roles grant nothing. */
export function can(memberRole: string, permission: Permission): boolean {
  return memberRole
    .split(',')
    .map((r) => r.trim())
    .filter(isRoleName)
    .some((name) => roles[name].authorize(permission).success)
}

/**
 * What integrator API keys may ever hold (read and write only). Destructive,
 * money and approval actions are not grantable to a key under any scope.
 */
export const INTEGRATOR_SCOPES = {
  read: readAll,
  write: {
    ...readAll,
    expectedPayment: ['read', 'create', 'update'],
    exception: ['read', 'annotate'],
  },
} as const satisfies Record<string, Permission>

export type IntegratorScope = keyof typeof INTEGRATOR_SCOPES

/** True when every action in `permission` is granted by `granted`. */
export function grants(granted: Permission, permission: Permission): boolean {
  return Object.entries(permission).every(([resource, actions]) => {
    const allowed = (granted as Record<string, ReadonlyArray<string> | undefined>)[resource] ?? []
    return actions.every((action) => allowed.includes(action))
  })
}

/** Reads a scope back from stored key permissions; anything else is treated as no access. */
export function scopeOf(permissions: unknown): IntegratorScope | null {
  const same = (a: Permission) => JSON.stringify(sortPermission(a)) === JSON.stringify(sortPermission(permissions))
  if (same(INTEGRATOR_SCOPES.write)) return 'write'
  if (same(INTEGRATOR_SCOPES.read)) return 'read'
  return null
}

function sortPermission(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, Array.isArray(v) ? [...(v as string[])].sort() : v]),
  )
}
