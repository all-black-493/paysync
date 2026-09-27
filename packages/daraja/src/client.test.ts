import { describe, expect, it } from 'vitest'
import { DarajaClient, DarajaError, assertCallbackUrl, normalizeMsisdn, type CachedToken, type TokenStore } from './client.js'

function memoryStore(): TokenStore & { fetches: number } {
  const tokens = new Map<string, CachedToken>()
  let lock: Promise<unknown> = Promise.resolve()
  return {
    fetches: 0,
    read: (id) => Promise.resolve(tokens.get(id) ?? null),
    write: (id, token) => {
      tokens.set(id, token)
      return Promise.resolve()
    },
    withLock<T>(_id: string, fn: () => Promise<T>): Promise<T> {
      const run = lock.then(fn, fn)
      lock = run.catch(() => undefined)
      return run
    },
  }
}

const silent = { info: () => undefined, warn: () => undefined }
const credentials = { consumerKey: 'key', consumerSecret: 'secret', passkey: 'passkey' }
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

interface Call {
  readonly url: string
  readonly auth: string
  readonly body: Record<string, unknown> | null
}

function fakeDaraja(handler: (call: Call, n: number) => Response) {
  const calls: Call[] = []
  const fetchImpl = (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    const call: Call = {
      url: input instanceof Request ? input.url : input.toString(),
      auth: headers.get('authorization') ?? '',
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    }
    calls.push(call)
    return Promise.resolve(handler(call, calls.length))
  }
  return { calls, fetchImpl }
}

let tokenCounter = 0
const oauth = () => json(200, { access_token: `token-${++tokenCounter}-xxxxxxxxxxxxxxxx`, expires_in: '3599' })

function client(store: TokenStore, fetchImpl: typeof fetch, now = () => new Date('2026-09-28T09:00:00Z')) {
  return new DarajaClient({ environment: 'sandbox', credentialId: 'sandbox-app', credentials, tokenStore: store, logger: silent, fetch: fetchImpl, now })
}

const queryOk = json(200, {
  ResponseCode: '0',
  ResponseDescription: 'ok',
  MerchantRequestID: 'm',
  CheckoutRequestID: 'ws_CO_1',
  ResultCode: '0',
  ResultDesc: 'The service request is processed successfully.',
})

describe('access tokens', () => {
  it('concurrent callers and two replicas share one token fetch', async () => {
    const store = memoryStore()
    const fake = fakeDaraja((call) => (call.url.includes('/oauth/') ? oauth() : queryOk.clone()))
    const a = client(store, fake.fetchImpl)
    const b = client(store, fake.fetchImpl)
    await Promise.all([a.stkQuery('174379', 'ws_CO_1'), a.stkQuery('174379', 'ws_CO_1'), b.stkQuery('174379', 'ws_CO_1')])
    expect(fake.calls.filter((c) => c.url.includes('/oauth/'))).toHaveLength(1)
  })

  it('refreshes about five minutes before expiry', async () => {
    const store = memoryStore()
    const fake = fakeDaraja((call) => (call.url.includes('/oauth/') ? oauth() : queryOk.clone()))
    let now = new Date('2026-09-28T09:00:00Z')
    const c = client(store, fake.fetchImpl, () => now)
    await c.stkQuery('174379', 'ws_CO_1')
    now = new Date(now.getTime() + 54 * 60 * 1000)
    await c.stkQuery('174379', 'ws_CO_1')
    expect(fake.calls.filter((x) => x.url.includes('/oauth/'))).toHaveLength(1)
    now = new Date(now.getTime() + 2 * 60 * 1000)
    await c.stkQuery('174379', 'ws_CO_1')
    expect(fake.calls.filter((x) => x.url.includes('/oauth/'))).toHaveLength(2)
  })

  it('when Daraja rejects a token (rotated elsewhere) it fetches a new one and retries once', async () => {
    const store = memoryStore()
    let rejectFirst = true
    const fake = fakeDaraja((call) => {
      if (call.url.includes('/oauth/')) return oauth()
      if (rejectFirst) {
        rejectFirst = false
        return json(404, { requestId: 'r', errorCode: '404.001.03', errorMessage: 'Invalid Access Token' })
      }
      return queryOk.clone()
    })
    const result = await client(store, fake.fetchImpl).stkQuery('174379', 'ws_CO_1')
    expect(result.outcome).toBe('succeeded')
    const auths = fake.calls.filter((c) => !c.url.includes('/oauth/')).map((c) => c.auth)
    expect(auths).toHaveLength(2)
    expect(auths[0]).not.toBe(auths[1])
  })
})

describe('retries', () => {
  it('STK query retries a transient 500 with an empty message', async () => {
    const fake = fakeDaraja((call, n) =>
      call.url.includes('/oauth/')
        ? oauth()
        : n === 2
          ? json(500, { requestId: 'r', errorCode: '500.001.1001', errorMessage: '' })
          : queryOk.clone(),
    )
    await expect(client(memoryStore(), fake.fetchImpl).stkQuery('174379', 'ws_CO_1')).resolves.toMatchObject({ outcome: 'succeeded' })
  })

  it('STK query reports an unknown checkout as unknown, not failed', async () => {
    const fake = fakeDaraja((call) =>
      call.url.includes('/oauth/') ? oauth() : json(500, { requestId: 'r', errorCode: '500.001.1001', errorMessage: 'The transaction does not Exist' }),
    )
    await expect(client(memoryStore(), fake.fetchImpl).stkQuery('174379', 'ws_CO_X')).resolves.toMatchObject({ outcome: 'unknown' })
  })

  it('never retries an STK push, which can charge a customer', async () => {
    const fake = fakeDaraja((call) => (call.url.includes('/oauth/') ? oauth() : json(503, { errorCode: '503', errorMessage: '' })))
    const push = client(memoryStore(), fake.fetchImpl).stkPush({
      shortcode: '174379',
      transactionType: 'CustomerPayBillOnline',
      amountMinor: 100n,
      phone: '0708374149',
      accountReference: 'INV1',
      description: 'rent',
      callbackUrl: 'https://example.com/hooks/stk/secret',
    })
    await expect(push).rejects.toBeInstanceOf(DarajaError)
    expect(fake.calls.filter((c) => c.url.includes('stkpush'))).toHaveLength(1)
  })
})

describe('request building', () => {
  it('builds the STK password from shortcode + passkey + EAT timestamp', async () => {
    const fake = fakeDaraja((call) =>
      call.url.includes('/oauth/')
        ? oauth()
        : json(200, { MerchantRequestID: 'm', CheckoutRequestID: 'ws_CO_1', ResponseCode: '0', ResponseDescription: 'ok' }),
    )
    await client(memoryStore(), fake.fetchImpl).stkPush({
      shortcode: '174379',
      transactionType: 'CustomerPayBillOnline',
      amountMinor: 35000n,
      phone: '+254 708 374 149',
      accountReference: 'UNIT-A1',
      description: 'Rent',
      callbackUrl: 'https://example.com/hooks/stk/secret',
    })
    const body = fake.calls.find((c) => c.url.includes('stkpush'))?.body
    expect(body).toMatchObject({ Timestamp: '20260928120000', Amount: 350, PartyA: '254708374149', PhoneNumber: '254708374149' })
    expect(Buffer.from(String(body?.Password), 'base64').toString()).toBe('174379passkey20260928120000')
  })

  it('rejects callback URLs Daraja would refuse', () => {
    for (const url of ['https://x.com/mpesa/cb', 'https://x.com/hooks/query', 'https://safaricom.example/cb', 'https://x.com/SQL']) {
      expect(() => {
        assertCallbackUrl(url, 'sandbox')
      }).toThrow(DarajaError)
    }
    assertCallbackUrl('http://abc.ngrok-free.app/hooks/c2b/confirmation/secret', 'sandbox')
  })

  it('normalizes Kenyan mobile numbers', () => {
    expect(normalizeMsisdn('0712345678')).toBe('254712345678')
    expect(normalizeMsisdn('+254 112 345 678')).toBe('254112345678')
    expect(() => normalizeMsisdn('0612345678')).toThrow()
  })
})
