import { createTestDatabase, type TestDatabase } from '@paysync/test-utils'
import { safe } from '@orpc/client'
import type { UIMessageChunk } from 'ai'
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Assistant } from './agent/assistant.js'
import { addMember, createOrg, createUser, rpcClient, signIn, startTestApi, type TestApi, type TestUser } from './harness.test.support.js'

type StreamPart = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer T> ? T : never
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }
const finish = (reason: 'stop' | 'tool-calls') => ({ type: 'finish' as const, finishReason: { unified: reason, raw: reason }, usage })

/** First turn: list the exceptions; second: answer in words. No OpenAI call. */
function scripted(): MockLanguageModelV4 {
  let call = 0
  return new MockLanguageModelV4({
    doStream: () => {
      call += 1
      const parts: StreamPart[] =
        call === 1
          ? [{ type: 'stream-start', warnings: [] }, { type: 'tool-call', toolCallId: 't1', toolName: 'list_exceptions', input: '{}' }, finish('tool-calls')]
          : [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 'x' },
              { type: 'text-delta', id: 'x', delta: 'No open exceptions.' },
              { type: 'text-end', id: 'x' },
              finish('stop'),
            ]
      return Promise.resolve({ stream: convertArrayToReadableStream<StreamPart>(parts) })
    },
  })
}

const assistant = (turnsPerHour = 30): Assistant => ({ model: scripted(), approvalSecret: new Uint8Array(32).fill(7), turnsPerHour, maxSteps: 4, maxOutputTokens: 200 })

let database: TestDatabase
let api: TestApi
let admin: pg.Pool
let orgId: string
let clerkCookie: string
let viewerCookie: string
let clerk: TestUser

async function turn(cookie: string, text = 'What is open?') {
  const chunks: UIMessageChunk[] = []
  const stream = await rpcClient(api, cookie).assistant.chat({
    chatId: `test${String(Date.now())}`,
    messages: [{ id: `m${String(Date.now())}`, role: 'user', parts: [{ type: 'text', text }] }],
  })
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

beforeAll(async () => {
  database = await createTestDatabase()
  api = await startTestApi(database, { assistant: assistant(3) })
  admin = database.pool('admin')
  const owner = await createUser(api.auth, 'Olga')
  clerk = await createUser(api.auth, 'Cleo')
  const viewer = await createUser(api.auth, 'Vic')
  orgId = await createOrg(api.auth, 'Acme', owner)
  await addMember(api.auth, orgId, clerk, 'clerk')
  await addMember(api.auth, orgId, viewer, 'viewer')
  clerkCookie = await signIn(api, clerk)
  viewerCookie = await signIn(api, viewer)
})

afterAll(async () => {
  await api.close()
  await database.drop()
})

describe('assistant.chat', () => {
  it('streams a reply, calling tools as the person, and audits the turn', async () => {
    const chunks = await turn(clerkCookie)
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'tool-output-available', output: { items: [], nextCursor: null } }))
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'text-delta', delta: 'No open exceptions.' }))
    const { rows } = await admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM audit.event WHERE org_id = $1 AND action = 'assistant.chat'`, [orgId])
    expect(rows[0]?.n).toBe('1')
  })

  it('is not for people without the permission', async () => {
    const [error] = await safe(turn(viewerCookie))
    expect(error).toMatchObject({ code: 'FORBIDDEN' })
  })

  it('stops after the hourly allowance (it costs money per turn)', async () => {
    await turn(clerkCookie)
    await turn(clerkCookie)
    const [error] = await safe(turn(clerkCookie))
    expect(error).toMatchObject({ code: 'RATE_LIMITED' })
  })

  it('answers ASSISTANT_OFF when it is not switched on', async () => {
    const off = await startTestApi(database)
    try {
      const [error] = await safe(
        rpcClient(off, await signIn(off, clerk)).assistant.chat({ chatId: 'offoffoff1', messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }),
      )
      expect(error).toMatchObject({ code: 'ASSISTANT_OFF' })
    } finally {
      await off.close()
    }
  })
})
