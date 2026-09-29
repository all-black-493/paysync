import { DarajaClient, fixture, type CachedToken, type PullRecord, type TokenStore } from '@paysync/daraja'
import { JOB_SCHEMA, createDb, graphileLogger, type Db } from '@paysync/db'
import { DEFAULT_MATCH_POLICY } from '@paysync/matching'
import type { IngestDeps } from '@paysync/ingest'
import { createLogger, createSealer } from '@paysync/platform'
import { createOrganization, createTestDatabase, type TestDatabase } from '@paysync/test-utils'
import { runOnce } from 'graphile-worker'
import type pg from 'pg'
import { DEFAULT_POLICY, resultUrlsFor, type VerificationPolicy, type WorkerDeps } from './deps.js'
import { taskList } from './tasks.js'

export const TEST_KEY = 'ab'.repeat(32)
export const SECRET = 'callback-secret-callback-secret-0123'
export const STK_SHORTCODE = '174379'
export const C2B_SHORTCODE = '600984'

export interface DarajaCall {
  readonly path: string
  readonly body: Record<string, unknown>
}

interface StkAnswer {
  readonly ResultCode: string
  readonly ResultDesc: string
}

/** Stands in for Daraja: answers are set per test; every request is recorded. */
export class FakeDaraja {
  readonly calls: DarajaCall[] = []
  readonly stk = new Map<string, StkAnswer>()
  pullRecords: PullRecord[] = []
  /** Runs before the synchronous answer, e.g. to deliver the result early. */
  onAsyncRequest: ((call: DarajaCall, ids: { OriginatorConversationID: string; ConversationID: string }) => Promise<void>) | null = null
  /** Paths that answer HTTP 500 (a failed call whose outcome is unknown). */
  readonly failing = new Set<string>()
  private sequence = 0

  callsTo(path: string): DarajaCall[] {
    return this.calls.filter((c) => c.path === path)
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = new URL(input instanceof Request ? input.url : input.toString()).pathname
    if (path.startsWith('/oauth')) return Response.json({ access_token: 'fake-token-0123456789', expires_in: '3599' })
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>
    const call = { path, body }
    this.calls.push(call)
    if (this.failing.has(path)) return Response.json({ requestId: 'r', errorCode: '500.003.1001', errorMessage: 'Internal Server Error' }, { status: 500 })
    switch (path) {
      case '/mpesa/stkpushquery/v1/query': {
        const answer = this.stk.get(String(body.CheckoutRequestID))
        if (!answer) return Response.json({ requestId: 'r', errorCode: '500.001.1001', errorMessage: 'The transaction does not exist' }, { status: 500 })
        return Response.json({ ResponseCode: '0', ResponseDescription: 'ok', MerchantRequestID: 'm', CheckoutRequestID: body.CheckoutRequestID, ...answer })
      }
      case '/mpesa/transactionstatus/v1/query':
      case '/mpesa/accountbalance/v1/query':
      case '/mpesa/reversal/v1/request': {
        const n = ++this.sequence
        const ids = { OriginatorConversationID: `orig-${n}`, ConversationID: `AG_TEST_${n}` }
        await this.onAsyncRequest?.(call, ids)
        return Response.json({ ...ids, ResponseCode: '0', ResponseDescription: 'Accept the service request successfully.' })
      }
      case '/pulltransactions/v1/query': {
        const offset = Number(body.OffSetValue)
        const page = this.pullRecords.slice(offset, offset + 2)
        return page.length === 0
          ? Response.json({ ResponseRefID: 'r', ResponseCode: '1001', ResponseMessage: 'No transactions' })
          : Response.json({ ResponseRefID: 'r', ResponseCode: '1000', ResponseMessage: 'Success', Response: [page] })
      }
      default:
        return Response.json({ errorCode: '404.003.01', errorMessage: 'Resource not found' }, { status: 404 })
    }
  }
}

function memoryTokenStore(): TokenStore {
  const tokens = new Map<string, CachedToken>()
  return {
    read: (id) => Promise.resolve(tokens.get(id) ?? null),
    write: (id, token) => Promise.resolve(void tokens.set(id, token)),
    withLock: (_id, fn) => fn(),
  }
}

export interface Harness {
  readonly database: TestDatabase
  readonly admin: pg.Pool
  readonly db: Db
  readonly deps: WorkerDeps
  readonly ingest: IngestDeps
  readonly fake: FakeDaraja
  readonly orgId: string
  readonly shortcodes: { readonly stk: string; readonly c2b: string }
  /** Moves the worker's clock (the database keeps real time). */
  advance(ms: number): void
  /** Runs queued jobs through graphile-worker until none are runnable. */
  runJobs(): Promise<void>
  count(from: string, params?: unknown[]): Promise<number>
  close(): Promise<void>
}

export interface HarnessOptions {
  readonly initiator?: boolean
  readonly resultUrls?: boolean
  readonly policy?: Partial<VerificationPolicy>
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const database = await createTestDatabase()
  const admin = database.pool('admin')
  const appPool = database.pool('app')
  const jobsPool = database.pool('app')
  const db = createDb(appPool)
  const logger = createLogger({ service: 'worker-test', level: 'silent' })
  const fake = new FakeDaraja()
  let offset = 0

  const orgId = await createOrganization(database, 'Acme')
  const { rows } = await admin.query<{ id: string; code: string }>(
    `INSERT INTO core.shortcode (org_id, code, kind, environment, c2b_enabled, stk_enabled, pull_enabled, initiator_enabled) VALUES
     ($1, $2, 'paybill', 'sandbox', false, true, false, false),
     ($1, $3, 'paybill', 'sandbox', true, false, true, true) RETURNING id, code`,
    [orgId, STK_SHORTCODE, C2B_SHORTCODE],
  )
  const idOf = (code: string) => rows.find((r) => r.code === code)?.id ?? ''

  const deps: WorkerDeps = {
    db,
    logger,
    environment: 'sandbox',
    pii: createSealer(TEST_KEY, 'pii'),
    daraja: new DarajaClient({
      environment: 'sandbox',
      credentialId: 'test',
      credentials: { consumerKey: 'key', consumerSecret: 'secret', passkey: 'passkey' },
      tokenStore: memoryTokenStore(),
      logger,
      fetch: fake.fetch,
      ...(options.initiator === false ? {} : { initiator: { name: 'testapi', securityCredential: 'ENCRYPTED' } }),
    }),
    resultUrls: options.resultUrls === false ? null : resultUrlsFor('https://paysync.example', SECRET),
    policy: { ...DEFAULT_POLICY, ...options.policy },
    matchPolicy: DEFAULT_MATCH_POLICY,
    now: () => new Date(Date.now() + offset),
  }

  return {
    database,
    admin,
    db,
    deps,
    ingest: deps,
    fake,
    orgId,
    shortcodes: { stk: idOf(STK_SHORTCODE), c2b: idOf(C2B_SHORTCODE) },
    advance: (ms) => {
      offset += ms
    },
    runJobs: () => runOnce({ pgPool: jobsPool, schema: JOB_SCHEMA, taskList: taskList(deps), logger: graphileLogger(logger) }),
    async count(from, params = []) {
      const { rows: result } = await admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${from}`, params)
      return Number(result[0]?.n)
    },
    close: () => database.drop(),
  }
}

/** A C2B confirmation for our C2B shortcode. */
export function c2bConfirmation(receipt: string, amount: string, billRef = 'UNIT-A1'): Record<string, unknown> {
  return {
    ...(structuredClone(fixture('c2b-confirmation').payload) as Record<string, unknown>),
    TransID: receipt,
    TransAmount: amount,
    BusinessShortCode: C2B_SHORTCODE,
    BillRefNumber: billRef,
  }
}

export function pullRecord(receipt: string, amount: string, billRef = 'UNIT-A1'): PullRecord {
  return {
    transactionId: receipt,
    trxDate: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    msisdn: '2547 ***** 126',
    sender: 'JOHN',
    transactiontype: 'c2b-pay-bill-debit',
    billreference: billRef,
    amount,
    organizationname: 'Acme',
  }
}

export function stkSuccess(checkout: string, receipt: string, amount: number): Record<string, unknown> {
  return {
    Body: {
      stkCallback: {
        MerchantRequestID: `m-${checkout}`,
        CheckoutRequestID: checkout,
        ResultCode: 0,
        ResultDesc: 'The service request is processed successfully.',
        CallbackMetadata: {
          Item: [
            { Name: 'Amount', Value: amount },
            { Name: 'MpesaReceiptNumber', Value: receipt },
            { Name: 'TransactionDate', Value: 20260928101500 },
            { Name: 'PhoneNumber', Value: 254708374149 },
          ],
        },
      },
    },
  }
}

export function transactionStatusResult(
  ids: { OriginatorConversationID: string; ConversationID: string },
  fields: { receipt: string; amount: string; status?: string; credit?: string; resultCode?: number },
): Record<string, unknown> {
  return {
    Result: {
      ResultType: 0,
      ResultCode: fields.resultCode ?? 0,
      ResultDesc: fields.resultCode ? 'The initiator information is invalid.' : 'The service request is processed successfully.',
      ...ids,
      TransactionID: 'SIM0000000',
      ResultParameters: {
        ResultParameter: [
          { Key: 'ReceiptNo', Value: fields.receipt },
          { Key: 'Amount', Value: fields.amount },
          { Key: 'TransactionStatus', Value: fields.status ?? 'Completed' },
          { Key: 'CreditPartyName', Value: fields.credit ?? `${C2B_SHORTCODE} - Acme` },
          { Key: 'DebitPartyName', Value: '254708374149 - John Doe' },
          { Key: 'FinalisedTime', Value: '20260928101500' },
        ],
      },
    },
  }
}

export function balanceResult(ids: { OriginatorConversationID: string; ConversationID: string }, utility: string, completed: string) {
  return {
    Result: {
      ResultType: '0',
      ResultCode: '0',
      ResultDesc: 'The service request is processed successfully',
      ...ids,
      TransactionID: 'OA90000000',
      ResultParameters: {
        ResultParameter: [
          {
            Key: 'AccountBalance',
            Value: `Working Account|KES|0.00|0.00|0.00|0.00&Utility Account|KES|${utility}|${utility}|0.00|0.00&Charges Paid Account|KES|0.00|0.00|0.00|0.00`,
          },
          { Key: 'BOCompletedTime', Value: completed },
        ],
      },
    },
  }
}
