import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { RoleName } from '@paysync/auth'
import { createAuth, type Auth } from './auth.js'
import type { Contract } from '@paysync/contract'
import { createDb, loadMigrations, type Db } from '@paysync/db'
import type { Jev } from '@paysync/decisions'
import type { Assistant } from './agent/assistant.js'
import { closeServer, createLogger, createSealer, listen } from '@paysync/platform'
import type { TestDatabase } from '@paysync/test-utils'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { RouterContractClient } from '@orpc/contract'
import { createApiServer, type ApiServer } from './server.js'

export const PUBLIC_URL = 'http://paysync.test'
export const PASSWORD = 'correct horse battery staple'
export const CALLBACK_SECRET = 'test-callback-secret-0123456789abcdef'
export const TEST_ENCRYPTION_KEY = randomBytes(32).toString('hex')

export interface TestApi extends ApiServer {
  readonly auth: Auth
  readonly db: Db
  readonly baseUrl: string
  close(): Promise<void>
}

export async function startTestApi(database: TestDatabase, options: { readonly jev?: Jev; readonly assistant?: Assistant } = {}): Promise<TestApi> {
  const pool = database.pool('app')
  const db = createDb(pool)
  const auth = createAuth({ db, secret: randomBytes(32).toString('hex'), baseURL: PUBLIC_URL })
  const api = createApiServer({
    pool,
    db,
    auth,
    ...(options.jev ? { jev: options.jev } : {}),
    ...(options.assistant ? { assistant: options.assistant } : {}),
    migrations: loadMigrations(),
    logger: createLogger({ service: 'test', level: 'error' }),
    publicUrl: PUBLIC_URL,
    docs: true,
    hooks: {
      callbackSecret: CALLBACK_SECRET,
      allowedIps: [],
      environment: 'sandbox',
      pii: createSealer(TEST_ENCRYPTION_KEY, 'pii'),
    },
  })
  await listen(api.server, 0, '127.0.0.1')
  const { port } = api.server.address() as AddressInfo
  return { ...api, auth, db, baseUrl: `http://127.0.0.1:${port}`, close: () => closeServer(api.server) }
}

export interface TestUser {
  readonly id: string
  readonly email: string
}

export async function createUser(auth: Auth, name: string): Promise<TestUser> {
  const email = `${name.toLowerCase()}-${randomBytes(4).toString('hex')}@paysync.test`
  const { user } = await auth.api.signUpEmail({ body: { email, password: PASSWORD, name } })
  return { id: user.id, email }
}

export async function createOrg(auth: Auth, name: string, owner: TestUser): Promise<string> {
  const org = await auth.api.createOrganization({
    body: { name, slug: `${name.toLowerCase()}-${randomBytes(4).toString('hex')}`, userId: owner.id },
  })
  return org.id
}

export async function addMember(auth: Auth, orgId: string, user: TestUser, role: RoleName): Promise<void> {
  await auth.api.addMember({ body: { organizationId: orgId, userId: user.id, role } })
}

let clientIp = 0

/** Signs in over HTTP like a browser and returns the cookie header to send back. */
export async function signIn(api: TestApi, user: TestUser, password = PASSWORD): Promise<string> {
  const res = await signInRequest(api, user, password, `10.0.0.${++clientIp % 250}`)
  if (!res.ok) throw new Error(`sign-in failed: ${res.status} ${await res.text()}`)
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';', 1)[0])
    .join('; ')
}

export function signInRequest(api: TestApi, user: TestUser, password: string, ip: string): Promise<Response> {
  return fetch(`${api.baseUrl}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: PUBLIC_URL, 'x-forwarded-for': ip },
    body: JSON.stringify({ email: user.email, password }),
  })
}

export function rpcClient(api: TestApi, cookie?: string): RouterContractClient<Contract> {
  const link = new RPCLink({
    origin: api.baseUrl,
    url: '/api/rpc',
    headers: () => ({ origin: PUBLIC_URL, ...(cookie ? { cookie } : {}) }),
  })
  return createORPCClient(link)
}

export async function rest(api: TestApi, cookie: string | undefined, method: string, path: string, body?: unknown) {
  return request(api, cookie ? { cookie } : {}, method, path, body)
}

export async function restWithKey(api: TestApi, apiKey: string, method: string, path: string, body?: unknown) {
  return request(api, { 'x-api-key': apiKey }, method, path, body)
}

async function request(api: TestApi, auth: Record<string, string>, method: string, path: string, body?: unknown) {
  const res = await fetch(`${api.baseUrl}/api${path}`, {
    method,
    headers: {
      origin: PUBLIC_URL,
      ...auth,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  return { status: res.status, body: text === '' ? undefined : (JSON.parse(text) as unknown) }
}

/** A Better Auth route called like the browser does, so its hooks run. */
export async function authPost(api: TestApi, cookie: string, path: string, body: unknown) {
  const res = await fetch(`${api.baseUrl}/api/auth${path}`, {
    method: 'POST',
    headers: { origin: PUBLIC_URL, cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text === '' ? undefined : (JSON.parse(text) as unknown) }
}

export const key = (label: string) => `${label}-${randomBytes(6).toString('hex')}`
