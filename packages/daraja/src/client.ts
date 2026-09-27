import { setTimeout as sleep } from 'node:timers/promises'
import type { z } from 'zod'
import { toWholeShillings } from './money.js'
import { stkOutcome, type StkOutcome } from './normalize.js'
import {
  C2BRegisterResponse,
  C2BSimulateResponse,
  DarajaErrorResponse,
  OAuthResponse,
  StkPushResponse,
  StkQueryResponse,
} from './schemas.js'
import { formatDarajaTimestamp } from './time.js'

export type DarajaEnvironment = 'sandbox'

const BASE_URLS: Record<DarajaEnvironment, string> = { sandbox: 'https://sandbox.safaricom.co.ke' }

/** Daraja rejects URLs containing these words (portal docs, C2B). */
const BANNED_URL_WORDS = ['m-pesa', 'mpesa', 'safaricom', 'exec', 'exe', 'cmd', 'sql', 'query']

/** Refresh this long before expiry (tokens live about an hour). */
const REFRESH_MARGIN_MS = 5 * 60 * 1000

export interface CachedToken {
  readonly token: string
  readonly expiresAt: Date
}

/**
 * Shared token storage. Each OAuth call invalidates the previous token, so all
 * replicas must share one token and refresh it one at a time.
 */
export interface TokenStore {
  read(credentialId: string): Promise<CachedToken | null>
  write(credentialId: string, token: CachedToken): Promise<void>
  /** Runs `fn` while holding a lock that is exclusive across processes. */
  withLock<T>(credentialId: string, fn: () => Promise<T>): Promise<T>
}

export interface DarajaCredentials {
  readonly consumerKey: string
  readonly consumerSecret: string
  readonly passkey: string
}

export interface DarajaLogger {
  info(obj: object, msg: string): void
  warn(obj: object, msg: string): void
}

export interface DarajaClientOptions {
  readonly environment: DarajaEnvironment
  /** Stable id for the credential set, used as the token cache key. Not the key itself. */
  readonly credentialId: string
  readonly credentials: DarajaCredentials
  readonly tokenStore: TokenStore
  readonly logger: DarajaLogger
  readonly timeoutMs?: number
  readonly fetch?: typeof fetch
  readonly now?: () => Date
}

export class DarajaError extends Error {
  readonly status: number | null
  readonly errorCode: string | null
  readonly retryable: boolean

  constructor(
    message: string,
    details: { status: number | null; errorCode: string | null; retryable: boolean },
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'DarajaError'
    this.status = details.status
    this.errorCode = details.errorCode
    this.retryable = details.retryable
  }
}

const INVALID_TOKEN_CODES = new Set(['404.001.03', '400.003.01'])

export function assertCallbackUrl(url: string, environment: DarajaEnvironment | 'production'): void {
  const parsed = new URL(url)
  const lower = url.toLowerCase()
  const banned = BANNED_URL_WORDS.find((w) => lower.includes(w))
  if (banned) throw new DarajaError(`callback URL contains "${banned}", which Daraja rejects`, noRetry)
  if (parsed.protocol !== 'https:' && environment !== 'sandbox') {
    throw new DarajaError('callback URLs must be HTTPS outside the sandbox', noRetry)
  }
}

const noRetry = { status: null, errorCode: null, retryable: false }

/** 07XXXXXXXX, +2547XXXXXXXX, 7XXXXXXXX → 2547XXXXXXXX (and the 1XX range). */
export function normalizeMsisdn(input: string): string {
  const digits = input.replace(/[\s+-]/g, '')
  const match = /^(?:254|0)?([17]\d{8})$/.exec(digits)
  if (!match?.[1]) throw new DarajaError('not a Kenyan mobile number', noRetry)
  return `254${match[1]}`
}

export interface StkPushInput {
  readonly shortcode: string
  readonly transactionType: 'CustomerPayBillOnline' | 'CustomerBuyGoodsOnline'
  readonly amountMinor: bigint
  readonly phone: string
  readonly accountReference: string
  readonly description: string
  readonly callbackUrl: string
}

export interface StkQueryResult {
  readonly outcome: StkOutcome | 'unknown'
  readonly resultCode: string | null
  readonly resultDesc: string
}

export class DarajaClient {
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch
  private readonly now: () => Date
  private memory: CachedToken | null = null

  constructor(private readonly options: DarajaClientOptions) {
    this.baseUrl = BASE_URLS[options.environment]
    this.timeoutMs = options.timeoutMs ?? 15_000
    this.fetchImpl = options.fetch ?? fetch
    this.now = options.now ?? (() => new Date())
  }

  async stkPush(input: StkPushInput) {
    assertCallbackUrl(input.callbackUrl, this.options.environment)
    if (input.accountReference.length > 12) throw new DarajaError('AccountReference is at most 12 characters', noRetry)
    if (input.description.length > 13) throw new DarajaError('TransactionDesc is at most 13 characters', noRetry)
    const phone = normalizeMsisdn(input.phone)
    return this.call('/mpesa/stkpush/v1/processrequest', StkPushResponse, {
      retry: false,
      body: {
        ...this.stkPassword(input.shortcode),
        TransactionType: input.transactionType,
        Amount: toWholeShillings(input.amountMinor),
        PartyA: phone,
        PartyB: input.shortcode,
        PhoneNumber: phone,
        CallBackURL: input.callbackUrl,
        AccountReference: input.accountReference,
        TransactionDesc: input.description,
      },
    })
  }

  async stkQuery(shortcode: string, checkoutRequestId: string): Promise<StkQueryResult> {
    try {
      const res = await this.call('/mpesa/stkpushquery/v1/query', StkQueryResponse, {
        retry: true,
        body: { ...this.stkPassword(shortcode), CheckoutRequestID: checkoutRequestId },
      })
      return { outcome: stkOutcome(res.ResultCode), resultCode: res.ResultCode, resultDesc: res.ResultDesc }
    } catch (error) {
      // "The transaction does not Exist": not a failure of the payment, just unknown to M-Pesa (yet).
      if (error instanceof DarajaError && error.errorCode === '500.001.1001' && !error.retryable) {
        return { outcome: 'unknown', resultCode: null, resultDesc: error.message }
      }
      throw error
    }
  }

  async registerC2BUrls(input: {
    shortcode: string
    confirmationUrl: string
    validationUrl: string
    responseType: 'Completed' | 'Cancelled'
  }) {
    assertCallbackUrl(input.confirmationUrl, this.options.environment)
    assertCallbackUrl(input.validationUrl, this.options.environment)
    return this.call('/mpesa/c2b/v2/registerurl', C2BRegisterResponse, {
      retry: true,
      body: {
        ShortCode: input.shortcode,
        ResponseType: input.responseType,
        ConfirmationURL: input.confirmationUrl,
        ValidationURL: input.validationUrl,
      },
    })
  }

  /** Sandbox only: asks Daraja to send a C2B payment to the registered URLs. */
  async simulateC2B(input: {
    shortcode: string
    commandId: 'CustomerPayBillOnline' | 'CustomerBuyGoodsOnline'
    amountMinor: bigint
    msisdn: string
    billRefNumber: string
  }) {
    return this.call('/mpesa/c2b/v2/simulate', C2BSimulateResponse, {
      retry: false,
      body: {
        ShortCode: Number(input.shortcode),
        CommandID: input.commandId,
        Amount: toWholeShillings(input.amountMinor),
        Msisdn: Number(normalizeMsisdn(input.msisdn)),
        BillRefNumber: input.billRefNumber,
      },
    })
  }

  private stkPassword(shortcode: string) {
    const timestamp = formatDarajaTimestamp(this.now())
    const password = Buffer.from(`${shortcode}${this.options.credentials.passkey}${timestamp}`).toString('base64')
    return { BusinessShortCode: shortcode, Password: password, Timestamp: timestamp }
  }

  private fresh(token: CachedToken | null): token is CachedToken {
    return token !== null && token.expiresAt.getTime() - this.now().getTime() > REFRESH_MARGIN_MS
  }

  /** `rejected` is a token Daraja just refused; it is never handed out again. */
  async accessToken(rejected?: string): Promise<string> {
    const usable = (t: CachedToken | null): t is CachedToken => this.fresh(t) && t.token !== rejected
    if (usable(this.memory)) return this.memory.token
    const { credentialId, tokenStore } = this.options
    const stored = await tokenStore.read(credentialId)
    if (usable(stored)) {
      this.memory = stored
      return stored.token
    }
    const token = await tokenStore.withLock(credentialId, async () => {
      const again = await tokenStore.read(credentialId)
      if (usable(again)) return again
      const fetched = await this.fetchToken()
      await tokenStore.write(credentialId, fetched)
      this.options.logger.info({ credentialId, expiresAt: fetched.expiresAt }, 'daraja token refreshed')
      return fetched
    })
    this.memory = token
    return token.token
  }

  private async fetchToken(): Promise<CachedToken> {
    const { consumerKey, consumerSecret } = this.options.credentials
    const basic = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64')
    const res = await this.send('GET', '/oauth/v1/generate?grant_type=client_credentials', `Basic ${basic}`, undefined, true)
    const parsed = OAuthResponse.parse(res)
    return { token: parsed.access_token, expiresAt: new Date(this.now().getTime() + parsed.expires_in * 1000) }
  }

  private async call<S extends z.ZodType>(
    path: string,
    schema: S,
    options: { body: Record<string, unknown>; retry: boolean },
  ): Promise<z.output<S>> {
    let token = await this.accessToken()
    let raw: unknown
    try {
      raw = await this.send('POST', path, `Bearer ${token}`, options.body, options.retry)
    } catch (error) {
      // Another replica may have rotated the token: get a different one and try once more.
      if (!(error instanceof DarajaError && error.errorCode !== null && INVALID_TOKEN_CODES.has(error.errorCode))) throw error
      token = await this.accessToken(token)
      raw = await this.send('POST', path, `Bearer ${token}`, options.body, options.retry)
    }
    const parsed = schema.safeParse(raw)
    if (!parsed.success) throw new DarajaError(`unexpected response from ${path}`, noRetry)
    return parsed.data
  }

  private async send(method: 'GET' | 'POST', path: string, authorization: string, body: unknown, retry: boolean) {
    const attempts = retry ? 3 : 1
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.sendOnce(method, path, authorization, body)
      } catch (error) {
        const retryable = error instanceof DarajaError ? error.retryable : true
        if (attempt >= attempts || !retryable) throw error
        const delay = 250 * 2 ** attempt + Math.floor(Math.random() * 250)
        this.options.logger.warn({ path, attempt, delay }, 'daraja call failed, retrying')
        await sleep(delay)
      }
    }
  }

  private async sendOnce(method: 'GET' | 'POST', path: string, authorization: string, body: unknown): Promise<unknown> {
    let res: Response
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { authorization, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      throw new DarajaError(`network error calling ${path}`, { status: null, errorCode: null, retryable: true }, error)
    }
    const text = await res.text()
    let json: unknown
    try {
      json = text === '' ? null : (JSON.parse(text) as unknown)
    } catch {
      throw new DarajaError(`non-JSON response (${res.status}) from ${path}`, { status: res.status, errorCode: null, retryable: res.status >= 500 })
    }
    if (res.ok) return json
    const error = DarajaErrorResponse.safeParse(json)
    const errorCode = error.success ? error.data.errorCode : null
    const message = error.success ? error.data.errorMessage : `HTTP ${res.status}`
    // An empty message on 500.001.1001 was seen as a transient sandbox error.
    const transient = res.status === 429 || res.status >= 502 || (res.status === 500 && message.trim() === '')
    throw new DarajaError(message === '' ? `HTTP ${res.status}` : message, { status: res.status, errorCode, retryable: transient })
  }
}
