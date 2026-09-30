import { createPermix } from 'permix'
import { describe, expect, it } from 'vitest'
import { customRolePermissions, PERMISSION_CATALOG, ROLE_GRANTS, toStatements, type AppPermission } from './catalog.js'
import { INTEGRATOR_RULES, keyPermissionsFor, rulesForMember, scopeOf, type PermissionsDefinition } from './permissions.js'
import { isValidCustomRoleName } from './roles.js'

function permixWith(rules: Parameters<ReturnType<typeof createPermix<PermissionsDefinition>>['setup']>[0]) {
  const permix = createPermix<PermissionsDefinition>()
  permix.setup(rules)
  return permix
}

function allowed(rules: unknown, path: string): boolean {
  const [entity = '', action = ''] = path.split('.')
  const table = (rules as Record<string, Record<string, unknown> | undefined>)[entity]
  return table?.[action] === true
}

const NEVER_FOR_KEYS = [
  'expectedPayment.void',
  'transaction.writeOff',
  'match.unmatch',
  'match.confirm',
  'reversal.request',
  'approval.approve',
  'apiKey.read',
  'apiKey.create',
  'apiKey.delete',
]

describe('role rules', () => {
  it('viewer reads only', () => {
    const p = permixWith(rulesForMember('viewer'))
    expect(p.check('expectedPayment.read')).toBe(true)
    expect(p.check('report.read')).toBe(true)
    expect(p.check('expectedPayment.create')).toBe(false)
    expect(p.check('exception.annotate')).toBe(false)
    expect(p.check('apiKey.read')).toBe(false)
  })

  it('clerk works the queue but cannot approve or reverse', () => {
    const p = permixWith(rulesForMember('clerk'))
    expect(p.check('expectedPayment.create')).toBe(true)
    expect(p.check('exception.annotate')).toBe(true)
    expect(p.check('approval.approve')).toBe(false)
    expect(p.check('reversal.request')).toBe(false)
  })

  it('accountant can approve; only admin and owner manage keys', () => {
    expect(permixWith(rulesForMember('accountant')).check('approval.approve')).toBe(true)
    expect(permixWith(rulesForMember('accountant')).check('apiKey.create')).toBe(false)
    expect(permixWith(rulesForMember('admin')).check('apiKey.create')).toBe(true)
    expect(permixWith(rulesForMember('owner')).check('apiKey.delete')).toBe(true)
  })

  it('several roles combine; unknown roles grant nothing', () => {
    expect(permixWith(rulesForMember('viewer,accountant')).check('approval.approve')).toBe(true)
    const nothing = permixWith(rulesForMember('member,superuser'))
    expect(nothing.check('expectedPayment.read')).toBe(false)
    expect(nothing.check('~any')).toBe(false)
  })
})

describe('custom roles', () => {
  const collector: readonly AppPermission[] = ['transaction.read', 'exception.read', 'exception.annotate']
  const roles = new Map([['Rent collector', collector]])

  it('grant exactly their permissions, alone or with a built-in role', () => {
    const p = permixWith(rulesForMember('Rent collector', roles))
    expect(p.check('exception.annotate')).toBe(true)
    expect(p.check('exception.resolve')).toBe(false)
    expect(p.check('approval.approve')).toBe(false)
    expect(permixWith(rulesForMember('viewer,Rent collector', roles)).check('report.read')).toBe(true)
  })

  it('a role the organization does not define grants nothing', () => {
    expect(permixWith(rulesForMember('Rent collector')).check('transaction.read')).toBe(false)
  })

  it('never hold team, role or key management, whatever is stored', () => {
    const stored = { transaction: ['read'], apiKey: ['create'], member: ['update'], ac: ['create'], organization: ['update'], exception: ['annotate', 'explode'] }
    expect(customRolePermissions(stored)).toEqual(['transaction.read', 'exception.annotate'])
    expect(customRolePermissions('not json')).toEqual([])
  })

  it('round-trip through the stored statement shape', () => {
    expect(customRolePermissions(toStatements(collector))).toEqual(collector)
  })

  it('offer every permission a custom role may hold, and nothing else', () => {
    const offered = PERMISSION_CATALOG.map((p) => p.permission)
    expect(customRolePermissions(toStatements(offered)).sort()).toEqual([...offered].sort())
    expect(offered).not.toContain('apiKey.create')
    expect(new Set(offered).size).toBe(offered.length)
    for (const p of ROLE_GRANTS.accountant) if (!p.startsWith('apiKey.')) expect(offered).toContain(p)
  })

  it('need a readable name that is not a built-in role', () => {
    for (const ok of ['Rent collector', 'Front-desk', 'Auditor 2']) expect(isValidCustomRoleName(ok), ok).toBe(true)
    for (const bad of ['owner', 'Admin', 'a', 'x,y', 'role;drop', ' spaced', 'trailing-', 'n'.repeat(41)]) expect(isValidCustomRoleName(bad), bad).toBe(false)
  })
})

describe('integrator scopes', () => {
  it('read and write scopes never include destructive, approval or key actions', () => {
    for (const scope of ['read', 'write'] as const) {
      for (const path of NEVER_FOR_KEYS) expect(allowed(INTEGRATOR_RULES[scope], path), `${scope} ${path}`).toBe(false)
    }
    expect(permixWith(INTEGRATOR_RULES.read).check('expectedPayment.create')).toBe(false)
    expect(permixWith(INTEGRATOR_RULES.write).check('expectedPayment.create')).toBe(true)
  })

  it('stored key scopes round-trip and anything else is no scope', () => {
    expect(scopeOf(keyPermissionsFor('read'))).toBe('read')
    expect(scopeOf(keyPermissionsFor('write'))).toBe('write')
    for (const bad of [null, {}, { paysync: ['admin'] }, { paysync: ['read', 'write'] }, { expectedPayment: ['create'] }]) {
      expect(scopeOf(bad)).toBeNull()
    }
  })
})
