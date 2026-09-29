import type { AgentMeta } from '@paysync/contract'
import { describe, expect, it } from 'vitest'
import { decide, type GuardRequest } from './decide.js'

const read: AgentMeta = { name: 'list_things', risk: 'read' }
const write: AgentMeta = { name: 'confirm_match', risk: 'write' }
const note: AgentMeta = { name: 'annotate', risk: 'write', approval: 'never' }
const destructive: AgentMeta = { name: 'void_expected_payment', risk: 'destructive' }
const money: AgentMeta = { name: 'request_reversal', risk: 'destructive', money: true, approvers: 2 }
const moneyOne: AgentMeta = { name: 'refund_small', risk: 'destructive', money: true }
const mcpOnly: AgentMeta = { name: 'thing', risk: 'read', exposeTo: ['mcp'] }

const request = (over: Partial<GuardRequest>): GuardRequest => ({
  meta: read,
  surface: 'web',
  actor: 'person',
  checks: { blocks: [], doubts: [] },
  production: false,
  ...over,
})

describe('exposure', () => {
  it('blocks agents from procedures without agent metadata (fail closed)', () => {
    expect(decide(request({ meta: undefined, surface: 'mcp', actor: 'machine' }))).toMatchObject({ kind: 'block', reasons: ['not available to agents'] })
    expect(decide(request({ meta: undefined, surface: 'ai-sdk', actor: 'machine' }))).toMatchObject({ kind: 'block' })
  })

  it('respects exposeTo', () => {
    expect(decide(request({ meta: mcpOnly, surface: 'ai-sdk', actor: 'machine' }))).toMatchObject({ kind: 'block', reasons: ['not available on ai-sdk'] })
    expect(decide(request({ meta: mcpOnly, surface: 'mcp', actor: 'machine' }))).toMatchObject({ kind: 'allow' })
  })

  it('people in the web app may call procedures that agents cannot', () => {
    expect(decide(request({ meta: undefined }))).toEqual({ kind: 'allow', reasons: [] })
  })
})

describe('deterministic checks', () => {
  it('a broken rule blocks everyone, before any approval', () => {
    for (const actor of ['person', 'machine'] as const) {
      expect(decide(request({ meta: destructive, actor, checks: { blocks: ['above the write-off cap'], doubts: [] } }))).toEqual({
        kind: 'block',
        reasons: ['above the write-off cap'],
      })
    }
  })
})

describe('static policy', () => {
  it('reads are allowed', () => {
    expect(decide(request({ meta: read, surface: 'mcp', actor: 'machine' }))).toMatchObject({ kind: 'allow' })
  })

  it('destructive actions always need one approval, for people too (maker-checker)', () => {
    expect(decide(request({ meta: destructive }))).toEqual({
      kind: 'require_approval',
      approvalsRequired: 1,
      reasons: ['destructive: always needs approval'],
    })
    expect(decide(request({ meta: destructive, surface: 'rest', actor: 'machine' }))).toMatchObject({ kind: 'require_approval' })
  })

  it('money actions always need approval: two approvers when the metadata says so, and always in production', () => {
    expect(decide(request({ meta: money }))).toMatchObject({ kind: 'require_approval', approvalsRequired: 2, reasons: ['moves money: always needs approval'] })
    expect(decide(request({ meta: moneyOne }))).toMatchObject({ approvalsRequired: 1 })
    expect(decide(request({ meta: moneyOne, production: true }))).toMatchObject({ approvalsRequired: 2 })
    expect(decide(request({ meta: { ...moneyOne, approval: 'never' } }))).toMatchObject({ kind: 'require_approval' })
  })

  it('on-doubt: machines with doubts need approval; people and doubt-free machines are allowed', () => {
    const doubts = { blocks: [], doubts: ['the reference does not fit the chosen expected payment'] }
    expect(decide(request({ meta: write, surface: 'mcp', actor: 'machine', checks: doubts }))).toEqual({
      kind: 'require_approval',
      approvalsRequired: 1,
      reasons: ['the reference does not fit the chosen expected payment'],
    })
    expect(decide(request({ meta: write, surface: 'rest', actor: 'machine', checks: doubts }))).toMatchObject({ kind: 'require_approval' })
    expect(decide(request({ meta: write, actor: 'person', checks: doubts }))).toMatchObject({ kind: 'allow' })
    expect(decide(request({ meta: write, surface: 'mcp', actor: 'machine' }))).toMatchObject({ kind: 'allow' })
  })

  it('approval never: allowed even with doubts', () => {
    expect(decide(request({ meta: note, surface: 'mcp', actor: 'machine', checks: { blocks: [], doubts: ['x'] } }))).toMatchObject({ kind: 'allow' })
  })
})
