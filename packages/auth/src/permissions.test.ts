import { createPermix } from 'permix'
import { describe, expect, it } from 'vitest'
import { INTEGRATOR_RULES, keyPermissionsFor, rulesForMember, scopeOf, type PermissionsDefinition } from './permissions.js'

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
