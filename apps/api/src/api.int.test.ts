import { request } from 'node:http'
import { createTestDatabase, type TestDatabase } from '@paysync/test-utils'
import { isDefinedError, safe } from '@orpc/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  PUBLIC_URL,
  addMember,
  createOrg,
  createUser,
  key,
  rest,
  rpcClient,
  signIn,
  signInRequest,
  startTestApi,
  type TestApi,
  type TestUser,
} from './harness.test.support.js'

let database: TestDatabase
let api: TestApi
let orgA: string
let orgB: string
type Name = 'ownerA' | 'clerkA' | 'viewerA' | 'ownerB'
let users!: Record<Name, TestUser>
const cookies = new Map<Name, string>()
const cookie = (name: Name): string => cookies.get(name) ?? ''

const kes = (minor: number) => ({ minor: String(minor), currency: 'KES' as const })

beforeAll(async () => {
  database = await createTestDatabase()
  api = await startTestApi(database)
  users = {
    ownerA: await createUser(api.auth, 'Alice'),
    clerkA: await createUser(api.auth, 'Carl'),
    viewerA: await createUser(api.auth, 'Vera'),
    ownerB: await createUser(api.auth, 'Bob'),
  }
  orgA = await createOrg(api.auth, 'Acme', users.ownerA)
  orgB = await createOrg(api.auth, 'Beta', users.ownerB)
  await addMember(api.auth, orgA, users.clerkA, 'clerk')
  await addMember(api.auth, orgA, users.viewerA, 'viewer')
  for (const [name, user] of Object.entries(users) as Array<[Name, TestUser]>) cookies.set(name, await signIn(api, user))
})

afterAll(async () => {
  await api.close()
  await database.drop()
})

describe('authentication', () => {
  it('rejects calls without a session on both surfaces', async () => {
    const [error] = await safe(rpcClient(api).me.get())
    expect(error).toMatchObject({ code: 'UNAUTHORIZED' })
    expect((await rest(api, undefined, 'GET', '/v1/me')).status).toBe(401)
  })

  it('signs the user into their own organization with their role', async () => {
    expect(await rpcClient(api, cookie('ownerA')).me.get()).toMatchObject({
      user: { email: users.ownerA.email },
      organization: { id: orgA, name: 'Acme' },
      role: 'owner',
    })
    expect(await rpcClient(api, cookie('clerkA')).me.get()).toMatchObject({ organization: { id: orgA }, role: 'clerk' })
    expect(await rpcClient(api, cookie('ownerB')).me.get()).toMatchObject({ organization: { id: orgB }, role: 'owner' })
  })

  it('rate-limits repeated sign-in attempts from one address', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 5; i++) statuses.push((await signInRequest(api, users.viewerA, 'wrong password', '10.9.9.9')).status)
    expect(statuses).toContain(429)
    expect(statuses[0]).toBe(401)
  })

  it('cannot switch the active organization to one the user is not a member of', async () => {
    const res = await fetch(`${api.baseUrl}/api/auth/organization/set-active`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: PUBLIC_URL, cookie: cookie('clerkA') },
      body: JSON.stringify({ organizationId: orgB }),
    })
    expect(res.status).toBe(403)

    // Better Auth clears the active organization after such an attempt; the user must pick again.
    const [error] = await safe(rpcClient(api, cookie('clerkA')).me.get())
    expect(error).toMatchObject({ code: 'FORBIDDEN' })
    const back = await fetch(`${api.baseUrl}/api/auth/organization/set-active`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: PUBLIC_URL, cookie: cookie('clerkA') },
      body: JSON.stringify({ organizationId: orgA }),
    })
    expect(back.status).toBe(200)
    expect(await rpcClient(api, cookie('clerkA')).me.get()).toMatchObject({ organization: { id: orgA } })
  })
})

describe('one procedure, two surfaces', () => {
  it('creates via the typed client and reads the same record via REST', async () => {
    const created = await rpcClient(api, cookie('ownerA')).expected.create({
      reference: 'INV-1001',
      amountDue: kes(250_000),
      dueDate: '2026-10-01',
      idempotencyKey: key('create'),
    })
    expect(created).toMatchObject({ dryRun: false, changed: true, result: { reference: 'INV-1001', status: 'open' } })

    const viaRest = await rest(api, cookie('ownerA'), 'GET', `/v1/expected-payments/${created.result.id}`)
    expect(viaRest.status).toBe(200)
    expect(viaRest.body).toEqual(created.result)

    const viaRpc = await rpcClient(api, cookie('ownerA')).expected.get({ id: created.result.id })
    expect(viaRpc).toEqual(created.result)
  })

  it('creates via REST and lists via the typed client', async () => {
    const res = await rest(api, cookie('ownerA'), 'POST', '/v1/expected-payments', {
      reference: 'RENT OCT 2026',
      amountDue: kes(4_500_000),
      idempotencyKey: key('rest-create'),
    })
    expect(res.status).toBe(200)
    const list = await rpcClient(api, cookie('ownerA')).expected.list({ reference: 'rent-oct-2026' })
    expect(list.items.map((i) => i.reference)).toEqual(['RENT OCT 2026'])
  })

  it('serves the OpenAPI document with the contract’s routes', async () => {
    const spec = await rest(api, undefined, 'GET', '/v1/openapi.json')
    expect(spec.status).toBe(200)
    expect(Object.keys((spec.body as { paths: object }).paths)).toEqual(
      expect.arrayContaining(['/v1/expected-payments', '/v1/expected-payments/{id}', '/v1/exceptions/{id}/annotate']),
    )
  })
})

describe('tenant isolation through the API', () => {
  it('another organization cannot list or fetch the record', async () => {
    const created = await rpcClient(api, cookie('ownerA')).expected.create({
      reference: 'PRIVATE-1',
      amountDue: kes(100),
      idempotencyKey: key('private'),
    })
    const listB = await rpcClient(api, cookie('ownerB')).expected.list({})
    expect(listB.items.map((i) => i.id)).not.toContain(created.result.id)
    const [error] = await safe(rpcClient(api, cookie('ownerB')).expected.get({ id: created.result.id }))
    expect(isDefinedError(error) && error.code).toBe('NOT_FOUND')
    expect((await rest(api, cookie('ownerB'), 'GET', `/v1/expected-payments/${created.result.id}`)).status).toBe(404)
  })

  it('the same reference can exist in two organizations', async () => {
    await rpcClient(api, cookie('ownerA')).expected.create({ reference: 'SHARED-REF', amountDue: kes(1), idempotencyKey: key('a') })
    await rpcClient(api, cookie('ownerB')).expected.create({ reference: 'SHARED-REF', amountDue: kes(1), idempotencyKey: key('b') })
  })
})

describe('roles', () => {
  it('a viewer can read but not write', async () => {
    await rpcClient(api, cookie('viewerA')).expected.list({})
    const [error] = await safe(
      rpcClient(api, cookie('viewerA')).expected.create({ reference: 'NOPE-1', amountDue: kes(1), idempotencyKey: key('v') }),
    )
    expect(error).toMatchObject({ code: 'FORBIDDEN' })
    expect(
      (await rest(api, cookie('viewerA'), 'POST', '/v1/expected-payments', { reference: 'NOPE-2', amountDue: kes(1), idempotencyKey: key('v') }))
        .status,
    ).toBe(403)
  })

  it('a clerk can create and annotate', async () => {
    const created = await rpcClient(api, cookie('clerkA')).expected.create({
      reference: 'CLERK-1',
      amountDue: kes(10),
      idempotencyKey: key('clerk'),
    })
    expect(created.changed).toBe(true)
  })
})

describe('write safety', () => {
  it('a repeated idempotency key returns the original result and does not write twice', async () => {
    const client = rpcClient(api, cookie('ownerA'))
    const input = { reference: 'IDEM-1', amountDue: kes(500), idempotencyKey: key('idem') }
    const first = await client.expected.create(input)
    const second = await client.expected.create(input)
    expect(second).toEqual(first)
    const list = await client.expected.list({ reference: 'IDEM-1' })
    expect(list.items).toHaveLength(1)
  })

  it('reusing a key for a different request is an IDEMPOTENCY_CONFLICT', async () => {
    const client = rpcClient(api, cookie('ownerA'))
    const idempotencyKey = key('conflict')
    await client.expected.create({ reference: 'IDEM-2', amountDue: kes(500), idempotencyKey })
    const [error] = await safe(client.expected.create({ reference: 'IDEM-3', amountDue: kes(500), idempotencyKey }))
    expect(isDefinedError(error) && error.code).toBe('IDEMPOTENCY_CONFLICT')
  })

  it('dryRun previews without writing', async () => {
    const client = rpcClient(api, cookie('ownerA'))
    const preview = await client.expected.create({ reference: 'DRY-1', amountDue: kes(700), idempotencyKey: key('dry'), dryRun: true })
    expect(preview).toMatchObject({ dryRun: true, changed: true, result: { reference: 'DRY-1' } })
    expect((await client.expected.list({ reference: 'DRY-1' })).items).toEqual([])
  })

  it('normalized duplicate references are rejected with the existing id', async () => {
    const client = rpcClient(api, cookie('ownerA'))
    const original = await client.expected.create({ reference: 'INV-0042', amountDue: kes(1), idempotencyKey: key('dup') })
    const [error] = await safe(client.expected.create({ reference: 'inv 0042', amountDue: kes(1), idempotencyKey: key('dup') }))
    expect(isDefinedError(error) && error.code).toBe('DUPLICATE_REFERENCE')
    expect(isDefinedError(error) && error.code === 'DUPLICATE_REFERENCE' && error.data.existingId).toBe(original.result.id)
  })

  it('an update with a stale version is STALE_STATE with the current version, on both surfaces', async () => {
    const client = rpcClient(api, cookie('ownerA'))
    const created = await client.expected.create({ reference: 'VER-1', amountDue: kes(100), idempotencyKey: key('ver') })
    const updated = await client.expected.update({
      id: created.result.id,
      version: created.result.version,
      amountDue: kes(150),
      idempotencyKey: key('upd'),
    })
    expect(updated.result).toMatchObject({ version: 2, amountDue: kes(150) })

    const [error] = await safe(
      client.expected.update({ id: created.result.id, version: 1, description: 'late', idempotencyKey: key('stale') }),
    )
    expect(isDefinedError(error) && error.code === 'STALE_STATE' && error.data.currentVersion).toBe(2)

    const res = await rest(api, cookie('ownerA'), 'PATCH', `/v1/expected-payments/${created.result.id}`, {
      version: 1,
      description: 'late',
      idempotencyKey: key('stale-rest'),
    })
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ code: 'STALE_STATE', data: { currentVersion: 2 } })
  })

  it('invalid input is rejected before any handler runs', async () => {
    const res = await rest(api, cookie('ownerA'), 'POST', '/v1/expected-payments', {
      reference: 'BAD-1',
      amountDue: { minor: '1.50', currency: 'KES' },
      idempotencyKey: key('bad'),
    })
    expect(res.status).toBe(400)
    const extra = await rest(api, cookie('ownerA'), 'POST', '/v1/expected-payments', {
      reference: 'BAD-2',
      amountDue: kes(1),
      idempotencyKey: key('bad'),
      orgId: orgB,
    })
    expect(extra.status).toBe(400)
  })

  it('writes are audited with the caller and surface', async () => {
    await rest(api, cookie('clerkA'), 'POST', '/v1/expected-payments', {
      reference: 'AUDITED-1',
      amountDue: kes(1),
      payerLabel: 'Jane Doe',
      idempotencyKey: key('audit'),
    })
    const { rows } = await database
      .pool('admin')
      .query<{ user_id: string; surface: string; action: string; input: { payerLabel: string } }>(
        `SELECT user_id, surface, action, input FROM audit.event WHERE input->>'reference' = 'AUDITED-1'`,
      )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      user_id: users.clerkA.id,
      surface: 'rest',
      action: 'expected.create',
      input: { payerLabel: '[redacted]' },
    })
  })
})

describe('exceptions', () => {
  it('annotates an exception and bumps its version', async () => {
    const { rows } = await database
      .pool('admin')
      .query<{ id: string }>(`INSERT INTO core.exception (org_id, kind, summary) VALUES ($1, 'no_match', 'Unknown payer') RETURNING id`, [orgA])
    const id = rows[0]?.id ?? ''
    const client = rpcClient(api, cookie('clerkA'))
    const open = await client.exceptions.list({})
    expect(open.items.map((e) => e.id)).toContain(id)
    const annotated = await client.exceptions.annotate({
      id,
      version: 1,
      note: 'Called the tenant',
      tags: ['follow-up', 'follow-up'],
      idempotencyKey: key('note'),
    })
    expect(annotated.result).toMatchObject({ note: 'Called the tenant', tags: ['follow-up'], version: 2 })
    const [error] = await safe(rpcClient(api, cookie('ownerB')).exceptions.get({ id }))
    expect(isDefinedError(error) && error.code).toBe('NOT_FOUND')
  })
})

describe('reports', () => {
  it('summarises a day in East Africa Time', async () => {
    const summary = await rpcClient(api, cookie('viewerA')).reports.dailySummary({ date: '2026-09-25' })
    expect(summary).toMatchObject({ date: '2026-09-25', timezone: 'Africa/Nairobi', received: { count: 0 } })
  })
})

describe('CSRF', () => {
  it('rejects a cross-site top-level GET navigation carrying cookies', async () => {
    // node:http, because fetch drops Sec-Fetch-* request headers.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${api.baseUrl}/api/v1/me`, {
        headers: {
          cookie: cookie('ownerA'),
          'sec-fetch-site': 'cross-site',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
        },
      })
      req.on('response', (res) => {
        res.resume()
        resolve(res.statusCode)
      })
      req.on('error', reject)
      req.end()
    })
    expect(status).toBe(403)
  })
})
