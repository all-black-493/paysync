import type { RoleName } from './roles.js'

/** Every application permission, entity → actions. Permix and Better Auth both derive from this. */
export const APP_STATEMENTS = {
  transaction: ['read', 'writeOff'],
  expectedPayment: ['read', 'create', 'update', 'void'],
  exception: ['read', 'annotate', 'resolve'],
  match: ['read', 'suggest', 'confirm', 'unmatch'],
  report: ['read'],
  pendingAction: ['read'],
  reconciliation: ['run'],
  approval: ['approve'],
  reversal: ['request'],
  apiKey: ['read', 'create', 'delete'],
} as const

export type AppEntity = keyof typeof APP_STATEMENTS
export type AppPermission = { [E in AppEntity]: `${E}.${(typeof APP_STATEMENTS)[E][number]}` }[AppEntity]

/**
 * What a custom role may hold: the reconciliation work itself. Team, role and
 * key management stay with the built-in owner and admin, so nobody can use a
 * custom role to hand themselves more power.
 */
export const CUSTOM_ROLE_ENTITIES = [
  'transaction',
  'expectedPayment',
  'exception',
  'match',
  'report',
  'pendingAction',
  'reconciliation',
  'approval',
  'reversal',
] as const satisfies readonly AppEntity[]

export interface PermissionInfo {
  readonly permission: AppPermission
  readonly group: string
  readonly label: string
  /** Shown next to the choice: why granting it deserves a second thought. */
  readonly caution?: string
}

/** The choices shown when an owner or admin builds a custom role, in reading order. */
export const PERMISSION_CATALOG: readonly PermissionInfo[] = [
  { permission: 'report.read', group: 'Viewing', label: 'See daily totals' },
  { permission: 'transaction.read', group: 'Viewing', label: 'See payments' },
  { permission: 'expectedPayment.read', group: 'Viewing', label: 'See expected payments' },
  { permission: 'exception.read', group: 'Viewing', label: 'See exceptions' },
  { permission: 'match.read', group: 'Viewing', label: 'See matches' },
  { permission: 'pendingAction.read', group: 'Viewing', label: 'See approval requests' },
  { permission: 'match.suggest', group: 'Matching', label: 'Get match suggestions' },
  { permission: 'match.confirm', group: 'Matching', label: 'Match payments' },
  { permission: 'exception.annotate', group: 'Matching', label: 'Add notes to exceptions' },
  { permission: 'exception.resolve', group: 'Matching', label: 'Close exceptions' },
  { permission: 'reconciliation.run', group: 'Matching', label: 'Run reconciliation' },
  { permission: 'expectedPayment.create', group: 'Expected payments', label: 'Add expected payments' },
  { permission: 'expectedPayment.update', group: 'Expected payments', label: 'Change expected payments' },
  { permission: 'expectedPayment.void', group: 'Requests', label: 'Request a void', caution: 'Needs an approver.' },
  { permission: 'match.unmatch', group: 'Requests', label: 'Request to undo a match', caution: 'Needs an approver.' },
  { permission: 'transaction.writeOff', group: 'Requests', label: 'Request a write-off', caution: 'Needs an approver.' },
  { permission: 'reversal.request', group: 'Requests', label: 'Request a reversal', caution: 'Moves money back; needs two approvers.' },
  {
    permission: 'approval.approve',
    group: 'Approving',
    label: 'Approve or reject requests',
    caution: 'They must turn on two-factor authentication, and can never approve their own request.',
  },
]

const ALL_READ: readonly AppPermission[] = [
  'transaction.read',
  'expectedPayment.read',
  'exception.read',
  'match.read',
  'match.suggest',
  'report.read',
  'pendingAction.read',
]

const CLERK: readonly AppPermission[] = [
  ...ALL_READ,
  'transaction.writeOff',
  'expectedPayment.create',
  'expectedPayment.update',
  'expectedPayment.void',
  'exception.annotate',
  'exception.resolve',
  'match.confirm',
  'match.unmatch',
  'reconciliation.run',
]

const ACCOUNTANT: readonly AppPermission[] = [...CLERK, 'approval.approve', 'reversal.request']
const ADMIN: readonly AppPermission[] = [...ACCOUNTANT, 'apiKey.read', 'apiKey.create', 'apiKey.delete']

/** The built-in roles. A clerk may request destructive actions; they go through approval. */
export const ROLE_GRANTS: Readonly<Record<RoleName, readonly AppPermission[]>> = {
  viewer: ALL_READ,
  clerk: CLERK,
  accountant: ACCOUNTANT,
  admin: ADMIN,
  owner: ADMIN,
}

export function isAppPermission(value: string): value is AppPermission {
  const [entity, action] = value.split('.')
  if (!entity || !action || !Object.hasOwn(APP_STATEMENTS, entity)) return false
  return (APP_STATEMENTS[entity as AppEntity] as readonly string[]).includes(action)
}

/** Better Auth stores a role's permissions as entity → actions. */
export function toStatements(permissions: Iterable<AppPermission>): Partial<Record<AppEntity, string[]>> {
  const out: Partial<Record<AppEntity, string[]>> = {}
  for (const p of permissions) {
    const [entity, action] = p.split('.') as [AppEntity, string]
    ;(out[entity] ??= []).push(action)
  }
  return out
}

/** The reverse, keeping only application permissions a custom role may hold; anything else is dropped. */
export function customRolePermissions(statements: unknown): AppPermission[] {
  if (typeof statements !== 'object' || statements === null) return []
  const out: AppPermission[] = []
  for (const [entity, actions] of Object.entries(statements)) {
    if (!(CUSTOM_ROLE_ENTITIES as readonly string[]).includes(entity) || !Array.isArray(actions)) continue
    for (const action of actions) {
      const path = `${entity}.${String(action)}`
      if (isAppPermission(path)) out.push(path)
    }
  }
  return out
}
