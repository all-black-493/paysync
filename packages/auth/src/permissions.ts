import { createRules, type ValidateDefinition } from 'permix'
import { APP_STATEMENTS, ROLE_GRANTS, type AppEntity, type AppPermission } from './catalog.js'
import { isRoleName, parseRoleList } from './roles.js'

type Mutable<T> = { -readonly [K in keyof T]: [...(T[K] extends readonly unknown[] ? T[K] : never)] }

export type PermissionsDefinition = ValidateDefinition<Mutable<typeof APP_STATEMENTS>>

type Rules = ReturnType<typeof createRules<PermissionsDefinition>>
type Table = Record<AppEntity, Record<string, boolean>>

function emptyTable(): Table {
  const table = {} as Table
  for (const [entity, actions] of Object.entries(APP_STATEMENTS) as Array<[AppEntity, readonly string[]]>) {
    table[entity] = Object.fromEntries(actions.map((a) => [a, false]))
  }
  return table
}

/** Permix rules granting exactly these permissions; everything else is false. */
export function rulesFrom(permissions: Iterable<AppPermission>): Rules {
  const table = emptyTable()
  for (const p of permissions) {
    const [entity, action] = p.split('.') as [AppEntity, string]
    table[entity][action] = true
  }
  return createRules<PermissionsDefinition>(table as Parameters<typeof createRules<PermissionsDefinition>>[0])
}

export const DENY_ALL: Rules = rulesFrom([])

/**
 * Union of every role the member holds. Built-in roles come from code; custom
 * roles from the organization's own definitions. Unknown roles grant nothing.
 */
export function rulesForMember(memberRole: string, customRoles: ReadonlyMap<string, readonly AppPermission[]> = new Map()): Rules {
  const granted = new Set<AppPermission>()
  for (const role of parseRoleList(memberRole)) {
    const permissions = isRoleName(role) ? ROLE_GRANTS[role] : customRoles.get(role)
    for (const p of permissions ?? []) granted.add(p)
  }
  return rulesFrom(granted)
}

const READ_ONLY_KEY: readonly AppPermission[] = [
  'transaction.read',
  'expectedPayment.read',
  'exception.read',
  'match.read',
  'report.read',
  'pendingAction.read',
]

/**
 * Integrator API keys: read, or read plus a few writes. A key can never
 * approve, void, write off, unmatch, reverse or manage keys, under any scope.
 */
export const INTEGRATOR_RULES = {
  read: rulesFrom(READ_ONLY_KEY),
  write: rulesFrom([...READ_ONLY_KEY, 'expectedPayment.create', 'expectedPayment.update', 'exception.annotate']),
} as const

export type IntegratorScope = keyof typeof INTEGRATOR_RULES

/** How a key's scope is stored in Better Auth's key record. */
export function keyPermissionsFor(scope: IntegratorScope): Record<string, string[]> {
  return { paysync: [scope] }
}

export function scopeOf(permissions: unknown): IntegratorScope | null {
  if (permissions === null || typeof permissions !== 'object' || !('paysync' in permissions)) return null
  const values: unknown = permissions.paysync
  if (!Array.isArray(values) || values.length !== 1) return null
  const scope: unknown = values[0]
  return scope === 'read' || scope === 'write' ? scope : null
}
