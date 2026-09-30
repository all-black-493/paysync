import type { AgentMeta } from '@paysync/contract'
import { describe, expect, it } from 'vitest'
import { decide, needsJudgement, type GuardRequest } from './decide.js'
import type { Judgement } from './judgement.js'

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

describe('Jev judgement (§8.3 step 7)', () => {
  const agent = (meta: AgentMeta, judgement: Judgement): GuardRequest => request({ meta, surface: 'mcp', actor: 'machine', judgement })
  const fine = (over: Partial<Extract<Judgement, { kind: 'answered' }>> = {}): Judgement => ({
    kind: 'answered',
    intent: 'matches_request',
    intentConfidence: 0.95,
    injection: 0.01,
    scope: 0.05,
    ...over,
  })

  it('is asked for agent calls that change something, never for people or reads', () => {
    expect(needsJudgement(write, 'mcp')).toBe(true)
    expect(needsJudgement(destructive, 'ai-sdk')).toBe(true)
    expect(needsJudgement(write, 'web')).toBe(false)
    expect(needsJudgement(write, 'rest')).toBe(false)
    expect(needsJudgement(read, 'mcp')).toBe(false)
    expect(needsJudgement(note, 'mcp')).toBe(false)
    expect(needsJudgement(undefined, 'mcp')).toBe(false)
  })

  it('a satisfied Jev lets an on-doubt write through', () => {
    expect(decide(agent(write, fine()))).toEqual({ kind: 'allow', reasons: [] })
  })

  it('injection above 0.2 blocks, even what would only need approval', () => {
    for (const meta of [write, destructive, money]) {
      expect(decide(agent(meta, fine({ injection: 0.21 })))).toMatchObject({ kind: 'block', reasons: [expect.stringContaining('instructions')] })
    }
    expect(decide(agent(write, fine({ injection: 0.2 }))).kind).toBe('allow')
  })

  it('scope above 0.3 needs a person', () => {
    expect(decide(agent(write, fine({ scope: 0.31 })))).toMatchObject({ kind: 'require_approval', reasons: [expect.stringContaining('further')] })
    expect(decide(agent(write, fine({ scope: 0.3 }))).kind).toBe('allow')
  })

  it('any intent but matches_request, or a confidence under 0.8, needs a person', () => {
    for (const intent of ['partially_matches', 'contradicts_request', 'unclear'] as const) {
      expect(decide(agent(write, fine({ intent })))).toMatchObject({ kind: 'require_approval', reasons: [expect.stringContaining(intent.replaceAll('_', ' '))] })
    }
    expect(decide(agent(write, fine({ intentConfidence: 0.79 })))).toMatchObject({ kind: 'require_approval', reasons: [expect.stringContaining('unsure')] })
    expect(decide(agent(write, fine({ intentConfidence: 0.8 }))).kind).toBe('allow')
  })

  it('no answer (error or over 800 ms) means a person decides: fail closed', () => {
    expect(decide(agent(write, { kind: 'unavailable', reason: 'timeout' }))).toMatchObject({
      kind: 'require_approval',
      reasons: ['Jev could not judge this action (timeout)'],
    })
  })

  it('destructive and money actions keep their approvals, with Jev’s doubts added', () => {
    expect(decide(agent(destructive, fine({ scope: 0.9 })))).toMatchObject({
      kind: 'require_approval',
      approvalsRequired: 1,
      reasons: ['destructive: always needs approval', expect.stringContaining('further')],
    })
    expect(decide(agent(money, fine()))).toMatchObject({ kind: 'require_approval', approvalsRequired: 2 })
  })

  it('never loosens: deterministic blocks and doubts stand whatever Jev says', () => {
    expect(decide({ ...agent(write, fine()), checks: { blocks: ['above the cap'], doubts: [] } })).toMatchObject({ kind: 'block', reasons: ['above the cap'] })
    expect(decide({ ...agent(write, fine()), checks: { blocks: [], doubts: ['reference does not fit'] } })).toMatchObject({ kind: 'require_approval' })
  })
})
