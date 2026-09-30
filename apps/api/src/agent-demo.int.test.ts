import { fakeJev } from '@paysync/decisions'
import { createLogger } from '@paysync/platform'
import { createTestDatabase, type TestDatabase } from '@paysync/test-utils'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runAgentDemo, type DemoReport } from './agent-demo/run.js'
import { PASSWORD, startTestApi, type TestApi } from './harness.test.support.js'

let database: TestDatabase
let api: TestApi
let report: DemoReport

const satisfied = fakeJev({ answer: (name) => (name === 'intent' ? { choice: 'matches_request', confidence: 0.95 } : name === 'injection' ? 0.01 : 0.05) })

beforeAll(async () => {
  database = await createTestDatabase()
  api = await startTestApi(database)
  report = await runAgentDemo({ auth: api.auth, db: api.db, logger: createLogger({ service: 'test', level: 'error' }), jev: satisfied }, PASSWORD)
}, 60_000)

afterAll(async () => {
  await api.close()
  await database.drop()
})

describe('M7 agent demo (AI SDK surface, scripted model)', () => {
  it('clears the backlog it safely can', () => {
    expect(report.openBefore).toBe(5)
    expect(report.transcript.filter((t) => t.startsWith('confirm_match') && t.includes('"changed":true'))).toHaveLength(3)
    expect(report.transcript.some((t) => t.startsWith('annotate_exception'))).toBe(true)
    // The one it only noted stays open for a person, with the duplicate waiting on its reversal.
    expect(report.openAfter).toBe(2)
  })

  it('is gated on the write-off and the reversal: requests wait in the web app, nothing moved', () => {
    expect(report.pending.map((p) => [p.procedure, p.approvalsRequired]).sort()).toEqual([
      ['reversals.request', 2],
      ['transactions.writeOffVariance', 1],
    ])
    expect(report.transcript.filter((t) => t.includes("needs the person's confirmation"))).toHaveLength(2)
    expect(report.answer).toContain('waiting for two approvers')
    expect(report.answer).toContain('waiting for an approver')
  })

  it('replay shows every decision of the session', () => {
    const lines = report.timeline.split('\n')
    expect(lines.filter((l) => l.includes('matches.confirm') && l.includes('[allow]'))).toHaveLength(3)
    expect(lines.some((l) => l.includes('exceptions.annotate'))).toBe(true)
    expect(lines.some((l) => l.includes('transactions.writeOffVariance') && l.includes('[require_approval]'))).toBe(true)
    expect(lines.some((l) => l.includes('reversals.request') && l.includes('[require_approval]'))).toBe(true)
    expect(lines.every((l) => l.includes('ai-sdk'))).toBe(true)
  })
})
