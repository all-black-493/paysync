import { createRules, type ValidateDefinition } from 'permix'
import { parseRoles, type RoleName } from './roles.js'

export type PermissionsDefinition = ValidateDefinition<{
  transaction: ['read', 'writeOff']
  expectedPayment: ['read', 'create', 'update', 'void']
  exception: ['read', 'annotate']
  match: ['read', 'suggest', 'confirm', 'unmatch']
  report: ['read']
  reconciliation: ['run']
  approval: ['approve']
  reversal: ['request']
  apiKey: ['read', 'create', 'delete']
}>

type Rules = ReturnType<typeof createRules<PermissionsDefinition>>

const none = {
  transaction: { read: false, writeOff: false },
  expectedPayment: { read: false, create: false, update: false, void: false },
  exception: { read: false, annotate: false },
  match: { read: false, suggest: false, confirm: false, unmatch: false },
  report: { read: false },
  reconciliation: { run: false },
  approval: { approve: false },
  reversal: { request: false },
  apiKey: { read: false, create: false, delete: false },
}

const viewer = createRules<PermissionsDefinition>({
  ...none,
  transaction: { read: true, writeOff: false },
  expectedPayment: { read: true, create: false, update: false, void: false },
  exception: { read: true, annotate: false },
  match: { read: true, suggest: true, confirm: false, unmatch: false },
  report: { read: true },
})

// A clerk may request destructive actions; they go through approval (M5).
const clerk = createRules<PermissionsDefinition>({
  ...viewer,
  transaction: { read: true, writeOff: true },
  expectedPayment: { read: true, create: true, update: true, void: true },
  exception: { read: true, annotate: true },
  match: { read: true, suggest: true, confirm: true, unmatch: true },
  reconciliation: { run: true },
})

const accountant = createRules<PermissionsDefinition>({
  ...clerk,
  approval: { approve: true },
  reversal: { request: true },
})

const admin = createRules<PermissionsDefinition>({
  ...accountant,
  apiKey: { read: true, create: true, delete: true },
})

export const ROLE_RULES: Readonly<Record<RoleName, Rules>> = { viewer, clerk, accountant, admin, owner: admin }

/**
 * Integrator API keys: read, or read plus a few writes. A key can never
 * approve, void, write off, unmatch, reverse or manage keys, under any scope.
 */
export const INTEGRATOR_RULES = {
  read: createRules<PermissionsDefinition>({ ...viewer, match: { read: true, suggest: false, confirm: false, unmatch: false } }),
  write: createRules<PermissionsDefinition>({
    ...viewer,
    match: { read: true, suggest: false, confirm: false, unmatch: false },
    expectedPayment: { read: true, create: true, update: true, void: false },
    exception: { read: true, annotate: true },
  }),
} as const

export type IntegratorScope = keyof typeof INTEGRATOR_RULES

export const DENY_ALL: Rules = createRules<PermissionsDefinition>(none)

/** Union of the rules of every role the member holds; unknown roles grant nothing. */
export function rulesForMember(memberRole: string): Rules {
  const granted = parseRoles(memberRole).map((r) => ROLE_RULES[r])
  const merged = structuredClone(none) as Record<string, Record<string, boolean>>
  for (const rules of granted) {
    for (const [entity, actions] of Object.entries(rules as Record<string, Record<string, unknown>>)) {
      for (const [action, value] of Object.entries(actions)) {
        const entityRules = merged[entity]
        if (entityRules && value === true) entityRules[action] = true
      }
    }
  }
  return createRules<PermissionsDefinition>(merged as typeof none)
}

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
