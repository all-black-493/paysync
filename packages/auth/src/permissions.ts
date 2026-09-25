import { createAccessControl } from 'better-auth/plugins/access'
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
} as const

export const ac = createAccessControl(statements)

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

export const roles = {
  viewer: ac.newRole(readAll),
  clerk: ac.newRole(clerkWork),
  accountant: ac.newRole(approverWork),
  admin: ac.newRole({ ...approverWork, ...adminAc.statements }),
  owner: ac.newRole({ ...approverWork, ...ownerAc.statements }),
}

export type RoleName = keyof typeof roles
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
