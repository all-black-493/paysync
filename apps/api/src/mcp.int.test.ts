import { createHash, randomBytes } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { agentProcedures } from '@paysync/contract'
import { createTestDatabase, type TestDatabase } from '@paysync/test-utils'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { PUBLIC_URL, addMember, createOrg, createUser, key, signIn, startTestApi, type TestApi, type TestUser } from './harness.test.support.js'
import { router } from './orpc/router.js'

const RESOURCE = `${PUBLIC_URL}/mcp`
const REDIRECT_URI = 'http://127.0.0.1:53682/callback'

let database: TestDatabase
let api: TestApi
let admin: pg.Pool
let orgId: string
let otherOrgId: string
let clerk: TestUser
let clientId: string

const base64url = (buf: Buffer) => buf.toString('base64url')

/** A public client as CIMD would store it (Better Auth's client endpoints are closed to everyone). */
async function registerClient(): Promise<string> {
  const id = key('client')
  await admin.query(
    `INSERT INTO auth.oauth_client (id, client_id, name, redirect_uris, token_endpoint_auth_method, grant_types, response_types, require_pkce, scopes, created_at, updated_at)
     VALUES ($1, $1, 'Test agent', $2, 'none', '{authorization_code,refresh_token}', '{code}', true, '{openid,profile,offline_access,paysync:read,paysync:write}', now(), now())`,
    [id, [REDIRECT_URI]],
  )
  await admin.query(
    `INSERT INTO auth.oauth_client_resource (id, client_id, resource_id, created_at)
     SELECT $1, $1, r.identifier, now() FROM auth.oauth_resource r WHERE r.identifier = $2`,
    [id, RESOURCE],
  )
  return id
}

/** The browser half of OAuth 2.1 with PKCE: authorize, consent in the web app, then exchange the code. */
async function accessToken(user: TestUser, scope: string, client = clientId): Promise<string> {
  const cookie = await signIn(api, user)
  const verifier = base64url(randomBytes(32))
  const authorize = new URL(`${api.baseUrl}/api/auth/oauth2/authorize`)
  for (const [k, v] of Object.entries({
    response_type: 'code',
    client_id: client,
    redirect_uri: REDIRECT_URI,
    scope,
    state: key('state'),
    code_challenge: base64url(createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
    resource: RESOURCE,
  })) authorize.searchParams.set(k, v)

  const toConsent = await fetch(authorize, { headers: { cookie, accept: 'application/json' }, redirect: 'manual' })
  const next = new URL(z.object({ url: z.string() }).parse(await toConsent.json()).url, PUBLIC_URL)
  // Consent given once for this client covers later, narrower requests.
  let url = next.href
  if (next.pathname === '/consent/') {
    const consent = await fetch(`${api.baseUrl}/api/auth/oauth2/consent`, {
      method: 'POST',
      headers: { cookie, origin: PUBLIC_URL, 'content-type': 'application/json' },
      body: JSON.stringify({ accept: true, oauth_query: next.search.slice(1) }),
    })
    url = z.object({ url: z.string() }).parse(await consent.json()).url
  }
  const code = z.string().parse(new URL(url).searchParams.get('code'))

  const token = await fetch(`${api.baseUrl}/api/auth/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: client, code_verifier: verifier, resource: RESOURCE }),
  })
  return z.object({ access_token: z.string() }).parse(await token.json()).access_token
}

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'paysync-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${api.baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  return client
}

const TextContent = z.object({ content: z.array(z.object({ type: z.literal('text'), text: z.string() })), isError: z.boolean().optional() })

/** The last text block of a tool result, parsed as JSON. */
function payload(result: unknown): unknown {
  const parsed = TextContent.parse(result)
  return JSON.parse(parsed.content.at(-1)?.text ?? 'null') as unknown
}

/** A token Better Auth really signed, with claims chosen by the test. */
async function signed(claims: Record<string, unknown>): Promise<string> {
  const { token } = await api.auth.api.signJWT({ body: { payload: { iss: `${PUBLIC_URL}/api/auth`, sub: clerk.id, org: orgId, azp: clientId, scope: 'openid paysync:read paysync:write', ...claims } } })
  return token
}

function mcpPost(token: string | null, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${api.baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify(body),
  })
}

beforeAll(async () => {
  database = await createTestDatabase()
  api = await startTestApi(database)
  admin = database.pool('admin')
  const owner = await createUser(api.auth, 'Olga')
  clerk = await createUser(api.auth, 'Cleo')
  orgId = await createOrg(api.auth, 'Acme', owner)
  otherOrgId = await createOrg(api.auth, 'Other', owner)
  await addMember(api.auth, orgId, clerk, 'clerk')
  clientId = await registerClient()
})

afterAll(async () => {
  await api.close()
  await database.drop()
})

describe('OAuth discovery for MCP clients', () => {
  it('publishes protected resource metadata naming our authorization server', async () => {
    const res = await fetch(`${api.baseUrl}/.well-known/oauth-protected-resource/mcp`)
    expect(res.status).toBe(200)
    const doc = z.object({ resource: z.string(), authorization_servers: z.array(z.string()), scopes_supported: z.array(z.string()) }).parse(await res.json())
    expect(doc.resource).toBe(RESOURCE)
    expect(doc.scopes_supported).toEqual(expect.arrayContaining(['paysync:read', 'paysync:write']))
    const [issuer] = doc.authorization_servers
    const meta = await fetch(`${api.baseUrl}/.well-known/oauth-authorization-server${new URL(z.string().parse(issuer)).pathname}`)
    expect(meta.status).toBe(200)
    expect(await meta.json()).toMatchObject({ issuer, code_challenge_methods_supported: ['S256'] })
  })

  it('answers an unauthenticated call with a challenge pointing at that metadata', async () => {
    const res = await mcpPost(null, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata=')
  })

  it('does not let anyone manage OAuth clients over HTTP', async () => {
    const cookie = await signIn(api, clerk)
    for (const path of ['/api/auth/oauth2/create-client', '/api/auth/oauth2/register', '/api/auth/admin/oauth2/create-client']) {
      const res = await fetch(`${api.baseUrl}${path}`, { method: 'POST', headers: { cookie, origin: PUBLIC_URL, 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT_URI] }) })
      expect(res.status, path).toBe(404)
    }
  })
})

describe('an external agent over MCP', () => {
  let client: Client

  beforeAll(async () => {
    client = await connect(await accessToken(clerk, 'openid offline_access paysync:read paysync:write'))
  })

  afterAll(async () => {
    await client.close()
  })

  it('negotiates the stateless 2026-07-28 protocol', () => {
    expect(client.getDiscoverResult()).toBeTruthy()
  })

  it('lists exactly the MCP agent tools, in a stable order, with closed schemas', async () => {
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)
    expect(names).toEqual(agentProcedures(router, 'mcp').map((p) => p.agent.name).sort((a, b) => a.localeCompare(b)))
    expect(names.some((n) => /approv|api_key/.test(n))).toBe(false)
    for (const tool of tools) expect(tool.inputSchema, tool.name).toMatchObject({ type: 'object', additionalProperties: false })
    expect(tools.find((t) => t.name === 'void_expected_payment')?.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false })
  })

  it('reads as the person who connected it, in their organization', async () => {
    const result = await client.callTool({ name: 'whoami', arguments: {} })
    expect(payload(result)).toMatchObject({ organization: { id: orgId }, role: 'clerk' })
  })

  it('rejects arguments the schema does not declare', async () => {
    const result = await client.callTool({ name: 'list_exceptions', arguments: { orgId: otherOrgId } })
    expect(result.isError).toBe(true)
  })

  it('hits the approval gate on a write, and the audit log names the MCP client', async () => {
    const result = await client.callTool({
      name: 'create_expected_payment',
      arguments: { reference: 'INV-MCP-1', amountDue: { minor: '10000', currency: 'KES' }, idempotencyKey: key('e') },
    })
    expect(result.isError).toBeFalsy()
    expect(payload(result)).toMatchObject({ status: 'waiting_for_approval', approvalsRequired: 1 })
    const { rows } = await admin.query<{ surface: string; mcp_client_id: string; user_id: string }>(
      `SELECT surface, mcp_client_id, user_id FROM audit.event WHERE org_id = $1 AND action = 'expected.create'`,
      [orgId],
    )
    expect(rows).toEqual([{ surface: 'mcp', mcp_client_id: clientId, user_id: clerk.id }])
    const created = await admin.query(`SELECT 1 FROM core.expected_payment WHERE org_id = $1`, [orgId])
    expect(created.rowCount).toBe(0)
  })
})

describe('tokens MCP refuses', () => {
  it('a token issued for another audience', async () => {
    const list = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
    const headers = { 'mcp-protocol-version': '2026-07-28' }
    expect((await mcpPost(await signed({ aud: `${PUBLIC_URL}/elsewhere` }), list, headers)).status).toBe(401)
    // The same token for this resource gets past authentication, so the audience alone made the difference.
    expect((await mcpPost(await signed({ aud: RESOURCE }), list, headers)).status).not.toBe(401)
  })

  it('a token for an organization the person does not belong to', async () => {
    const client = await connect(await signed({ aud: RESOURCE, org: otherOrgId }))
    const result = await client.callTool({ name: 'list_exceptions', arguments: {} })
    expect(result.isError).toBe(true)
    expect(payload(result)).toMatchObject({ status: 'refused', code: 'FORBIDDEN' })
    await client.close()
  })

  it('a read-only token asking for a write', async () => {
    const client = await connect(await accessToken(clerk, 'openid paysync:read'))
    await expect(client.callTool({ name: 'annotate_exception', arguments: { id: randomUUIDv7Like(), version: 1, note: 'x', idempotencyKey: key('n') } })).rejects.toThrow()
    expect(payload(await client.callTool({ name: 'whoami', arguments: {} }))).toMatchObject({ organization: { id: orgId } })
    await client.close()
  })
})

describe('disconnecting an app', () => {
  it('cuts it off at once, revokes its refresh tokens, and both steps are audited', async () => {
    const app = await registerClient()
    const client = await connect(await accessToken(clerk, 'openid offline_access paysync:read', app))
    expect(payload(await client.callTool({ name: 'whoami', arguments: {} }))).toMatchObject({ organization: { id: orgId } })

    const cookie = await signIn(api, clerk)
    const consents = z.array(z.object({ id: z.string(), clientId: z.string() })).parse(
      await (await fetch(`${api.baseUrl}/api/auth/oauth2/get-consents`, { headers: { cookie, origin: PUBLIC_URL } })).json(),
    )
    const consent = consents.find((c) => c.clientId === app)
    const res = await fetch(`${api.baseUrl}/api/auth/oauth2/delete-consent`, {
      method: 'POST',
      headers: { cookie, origin: PUBLIC_URL, 'content-type': 'application/json' },
      body: JSON.stringify({ id: consent?.id }),
    })
    expect(res.status).toBe(200)

    expect(payload(await client.callTool({ name: 'whoami', arguments: {} }))).toMatchObject({ status: 'refused', code: 'UNAUTHORIZED' })
    const live = await admin.query(`SELECT 1 FROM auth.oauth_refresh_token WHERE client_id = $1 AND revoked IS NULL`, [app])
    expect(live.rowCount).toBe(0)
    const { rows } = await admin.query<{ action: string }>(
      `SELECT action FROM audit.event WHERE org_id = $1 AND details->>'clientId' = $2 ORDER BY occurred_at`,
      [orgId, app],
    )
    expect(rows.map((r) => r.action)).toEqual(['oauth.connect', 'oauth.disconnect'])
    await client.close()
  })
})

function randomUUIDv7Like(): string {
  const hex = randomBytes(16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
