import { fakeJev, type Jev } from '@paysync/decisions'
import { createLogger } from '@paysync/platform'
import { createTestDatabase, type TestDatabase } from '@paysync/test-utils'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { agentTools } from './agent/tools.js'
import { PASSWORD, addMember, createOrg, createUser, key, startTestApi, type TestApi, type TestUser } from './harness.test.support.js'

let database: TestDatabase
let api: TestApi
let admin: pg.Pool
let orgId: string
let clerk: TestUser
let clerkHeaders: Headers

const logger = createLogger({ service: 'test', level: 'error' })
const satisfied = fakeJev({ answer: (name) => (name === 'intent' ? { choice: 'matches_request', confidence: 0.95 } : name === 'injection' ? 0.01 : 0.05) })

async function headersFor(user: TestUser): Promise<Headers> {
  const { headers } = await api.auth.api.signInEmail({ body: { email: user.email, password: PASSWORD }, returnHeaders: true })
  return new Headers({ cookie: headers.getSetCookie().map((c) => c.split(';', 1)[0]).join('; ') })
}

function toolsFor(headers: Headers, jev: Jev = satisfied) {
  return agentTools({ services: { auth: api.auth, db: api.db, logger, jev }, headers, sessionId: 'tools-test', userRequest: 'Tidy up the October rent' })
}

async function run(tools: ReturnType<typeof toolsFor>['tools'], name: string, input: unknown): Promise<unknown> {
  const execute = tools[name]?.execute
  if (!execute) throw new Error(`no tool ${name}`)
  const output: unknown = await execute(input as never, { toolCallId: key('call'), messages: [] } as never)
  return output
}

beforeAll(async () => {
  database = await createTestDatabase()
  api = await startTestApi(database)
  admin = database.pool('admin')
  const owner = await createUser(api.auth, 'Olga')
  clerk = await createUser(api.auth, 'Cleo')
  orgId = await createOrg(api.auth, 'Acme', owner)
  await addMember(api.auth, orgId, clerk, 'clerk')
  clerkHeaders = await headersFor(clerk)
})

afterAll(async () => {
  await api.close()
  await database.drop()
})

describe('AI SDK tools from the contract', () => {
  it('only procedures with agent metadata, under their stable names and agent-written descriptions', () => {
    const { tools } = toolsFor(clerkHeaders)
    expect(Object.keys(tools)).toContain('confirm_match')
    expect(Object.keys(tools)).toContain('request_reversal')
    for (const never of ['approve', 'decide_approval', 'create_api_key']) expect(Object.keys(tools)).not.toContain(never)
    expect(Object.keys(tools).some((n) => /approv|api_key/.test(n))).toBe(false)
    expect(tools.list_exceptions?.description).toContain('work queue')
  })

  it('destructive and money tools also need the person to confirm in chat (AI SDK human in the loop)', () => {
    const { toolApproval } = toolsFor(clerkHeaders)
    expect(Object.keys(toolApproval).sort()).toEqual(['request_reversal', 'unmatch', 'void_expected_payment', 'write_off_variance'])
    expect(Object.values(toolApproval).every((s) => s === 'user-approval')).toBe(true)
  })

  it('act as the person, with their permissions: a clerk’s agent cannot even ask for a reversal', async () => {
    const { tools } = toolsFor(clerkHeaders)
    expect(await run(tools, 'whoami', {})).toMatchObject({ actor: { id: clerk.id }, role: 'clerk' })
    const reversal = await run(tools, 'request_reversal', { transactionId: '01a0f1fe-0000-7000-8000-000000000000', version: 1, reason: 'test reversal', idempotencyKey: key('r') })
    expect(reversal).toMatchObject({ status: 'refused', code: 'FORBIDDEN' })
  })

  it('a write the guard blocks comes back as a plain result the agent can read', async () => {
    const { tools } = toolsFor(clerkHeaders, fakeJev({ answer: (name) => (name === 'intent' ? { choice: 'matches_request', confidence: 0.99 } : name === 'injection' ? 0.9 : 0) }))
    const created = await run(tools, 'create_expected_payment', { reference: 'INV-T1', amountDue: { minor: '10000', currency: 'KES' }, idempotencyKey: key('e') })
    expect(created).toMatchObject({ status: 'blocked', reason: expect.stringContaining('instructions') as unknown })
    const { rows } = await admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM core.expected_payment WHERE org_id = $1`, [orgId])
    expect(rows[0]?.n).toBe('0')
  })

  it('without a signed-in person nothing works', async () => {
    const { tools } = toolsFor(new Headers())
    expect(await run(tools, 'list_exceptions', {})).toMatchObject({ status: 'refused', code: 'UNAUTHORIZED' })
  })
})
