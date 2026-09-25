import { createTestDatabase, type TestDatabase } from '@paysync/test-utils'
import { safe } from '@orpc/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  PASSWORD,
  PUBLIC_URL,
  addMember,
  createOrg,
  createUser,
  key,
  rest,
  restWithKey,
  rpcClient,
  signIn,
  startTestApi,
  type TestApi,
} from './harness.test.support.js'

let database: TestDatabase
let api: TestApi
let orgA: string
let ownerCookie: string
let clerkCookie: string
let ownerBCookie: string

const kes = (minor: number) => ({ minor: String(minor), currency: 'KES' as const })

async function createKey(scope: 'read' | 'write', idempotencyKey = key('api-key')) {
  return rpcClient(api, ownerCookie).apiKeys.create({ name: `${scope} integration`, scope, idempotencyKey })
}

beforeAll(async () => {
  database = await createTestDatabase()
  api = await startTestApi(database)
  const owner = await createUser(api.auth, 'Olga')
  const clerk = await createUser(api.auth, 'Chris')
  const ownerB = await createUser(api.auth, 'Brian')
  orgA = await createOrg(api.auth, 'Acme', owner)
  await createOrg(api.auth, 'Beta', ownerB)
  await addMember(api.auth, orgA, clerk, 'clerk')
  ownerCookie = await signIn(api, owner)
  clerkCookie = await signIn(api, clerk)
  ownerBCookie = await signIn(api, ownerB)
  await rpcClient(api, ownerCookie).expected.create({ reference: 'INV-KEY-1', amountDue: kes(100), idempotencyKey: key('seed') })
})

afterAll(async () => {
  await api.close()
  await database.drop()
})

describe('integrator API keys', () => {
  it('are shown once, listed without the secret, and scoped to the owning organization', async () => {
    const created = await createKey('read')
    expect(created.result.key).toMatch(/^psk_/)
    expect(created.result.apiKey).toMatchObject({ scope: 'read', enabled: true })

    const listed = await rpcClient(api, ownerCookie).apiKeys.list()
    expect(listed.items.map((k) => k.id)).toContain(created.result.apiKey.id)
    expect(JSON.stringify(listed)).not.toContain(created.result.key)

    const me = await restWithKey(api, created.result.key ?? '', 'GET', '/v1/me')
    expect(me.body).toMatchObject({ actor: { type: 'api_key' }, organization: { id: orgA }, role: 'api_key:read' })
    const list = await restWithKey(api, created.result.key ?? '', 'GET', '/v1/expected-payments')
    expect(list.status).toBe(200)
    expect((list.body as { items: Array<{ reference: string }> }).items.map((i) => i.reference)).toEqual(['INV-KEY-1'])

    expect((await rpcClient(api, ownerBCookie).apiKeys.list()).items).toEqual([])
  })

  it('a read key cannot write; a write key can, and is audited as the key', async () => {
    const read = await createKey('read')
    const denied = await restWithKey(api, read.result.key ?? '', 'POST', '/v1/expected-payments', {
      reference: 'BY-READ-KEY',
      amountDue: kes(1),
      idempotencyKey: key('k'),
    })
    expect(denied.status).toBe(403)

    const write = await createKey('write')
    const created = await restWithKey(api, write.result.key ?? '', 'POST', '/v1/expected-payments', {
      reference: 'BY-WRITE-KEY',
      amountDue: kes(1),
      idempotencyKey: key('k'),
    })
    expect(created.status).toBe(200)
    const { rows } = await database
      .pool('admin')
      .query<{ user_id: string; surface: string }>(`SELECT user_id, surface FROM audit.event WHERE input->>'reference' = 'BY-WRITE-KEY'`)
    expect(rows).toEqual([{ user_id: `apikey:${write.result.apiKey.id}`, surface: 'rest' }])
  })

  it('keys cannot manage keys, and are refused on the RPC surface', async () => {
    const write = await createKey('write')
    const k = write.result.key ?? ''
    expect((await restWithKey(api, k, 'GET', '/v1/api-keys')).status).toBe(403)
    expect(
      (await restWithKey(api, k, 'POST', '/v1/api-keys', { name: 'escalate', scope: 'write', idempotencyKey: key('x') })).status,
    ).toBe(403)
    const rpc = await fetch(`${api.baseUrl}/api/rpc/me/get`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: PUBLIC_URL, 'x-api-key': k },
      body: JSON.stringify({ json: {} }),
    })
    expect(rpc.status).toBe(401)
  })

  it('only owners and admins can create keys', async () => {
    const [error] = await safe(rpcClient(api, clerkCookie).apiKeys.create({ name: 'nope', scope: 'read', idempotencyKey: key('c') }))
    expect(error).toMatchObject({ code: 'FORBIDDEN' })
  })

  it('a retried create returns the same key record without the secret', async () => {
    const idempotencyKey = key('retry')
    const first = await createKey('read', idempotencyKey)
    const again = await createKey('read', idempotencyKey)
    expect(first.result.key).toMatch(/^psk_/)
    expect(again.result).toEqual({ apiKey: first.result.apiKey, key: null })
  })

  it('revoked and unknown keys are rejected', async () => {
    const created = await createKey('read')
    const k = created.result.key ?? ''
    const revoked = await rpcClient(api, ownerCookie).apiKeys.revoke({ id: created.result.apiKey.id, idempotencyKey: key('rev') })
    expect(revoked.result.enabled).toBe(false)
    expect((await restWithKey(api, k, 'GET', '/v1/me')).status).toBe(401)
    expect((await restWithKey(api, 'psk_not-a-real-key', 'GET', '/v1/me')).status).toBe(401)
  })

  it('Better Auth’s own key endpoints are not reachable', async () => {
    const res = await fetch(`${api.baseUrl}/api/auth/api-key/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: PUBLIC_URL, cookie: ownerCookie },
      body: JSON.stringify({ name: 'raw', organizationId: orgA, configId: 'integrator' }),
    })
    expect(res.status).toBe(404)
  })
})

describe('invite-only sign-up', () => {
  const signUp = (email: string) =>
    fetch(`${api.baseUrl}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: PUBLIC_URL, 'x-forwarded-for': '10.1.1.1' },
      body: JSON.stringify({ email, password: PASSWORD, name: 'New Person' }),
    })

  it('refuses sign-up without an invitation', async () => {
    expect((await signUp('stranger@paysync.test')).status).toBe(403)
  })

  it('an invited person signs up, accepts, and lands in the organization with the invited role', async () => {
    const email = `invitee-${key('e')}@paysync.test`.toLowerCase()
    const invite = await fetch(`${api.baseUrl}/api/auth/organization/invite-member`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: PUBLIC_URL, cookie: ownerCookie },
      body: JSON.stringify({ email, role: 'clerk', organizationId: orgA }),
    })
    expect(invite.status).toBe(200)
    const invitation = (await invite.json()) as { id: string }

    const res = await signUp(email)
    expect(res.status).toBe(200)
    const cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(';', 1)[0])
      .join('; ')
    const accept = await fetch(`${api.baseUrl}/api/auth/organization/accept-invitation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: PUBLIC_URL, cookie },
      body: JSON.stringify({ invitationId: invitation.id }),
    })
    expect(accept.status).toBe(200)
    expect(await rpcClient(api, cookie).me.get()).toMatchObject({ organization: { id: orgA }, role: 'clerk' })
  })

  it('a clerk cannot invite', async () => {
    const res = await fetch(`${api.baseUrl}/api/auth/organization/invite-member`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: PUBLIC_URL, cookie: clerkCookie },
      body: JSON.stringify({ email: 'x@paysync.test', role: 'clerk', organizationId: orgA }),
    })
    expect(res.ok).toBe(false)
  })
})

describe('rest helper', () => {
  it('still works with cookies', async () => {
    expect((await rest(api, ownerCookie, 'GET', '/v1/me')).status).toBe(200)
  })
})
