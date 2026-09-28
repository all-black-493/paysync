import { describe, expect, it } from 'vitest'
import { DarajaClient, type CachedToken, type TokenStore } from './client.js'
import { fixture } from './fixtures.js'
import {
  formatPullDate,
  normalizeAccountBalanceResult,
  normalizePullRecord,
  normalizeTransactionStatusResult,
  parseAccountBalance,
  parsePullDate,
} from './results.js'
import { AsyncRequestResponse, DarajaResult, PullResponse } from './schemas.js'
import { createSecurityCredential, darajaCertificate } from './security.js'

describe('Transaction Status result', () => {
  it('normalizes the documented sample', () => {
    const result = normalizeTransactionStatusResult(DarajaResult.parse(fixture('transaction-status-result').payload))
    expect(result).toMatchObject({
      succeeded: true,
      resultCode: '0',
      conversationId: 'AG_20180223_0000493344ae97d86f75',
      originatorConversationId: '3213-416199-2',
      receiptNumber: 'MBN31H462N',
      amountMinor: 30000n,
      transactionStatus: 'Completed',
      creditParty: null,
    })
    expect(result.finalisedAt?.toISOString()).toBe('2018-02-23T02:41:12.000Z')
  })

  it('accepts a single ResultParameter object and a string ResultCode', () => {
    const body = {
      Result: {
        ResultCode: '2001',
        ResultDesc: 'The initiator information is invalid.',
        OriginatorConversationID: 'o',
        ConversationID: 'c',
        ResultParameters: { ResultParameter: { Key: 'ReceiptNo', Value: 'RKL51ZDR4F' } },
      },
    }
    const result = normalizeTransactionStatusResult(DarajaResult.parse(body))
    expect(result).toMatchObject({ succeeded: false, resultCode: '2001', receiptNumber: 'RKL51ZDR4F', amountMinor: null })
  })

  it('normalizes a real sandbox result for an unknown receipt', () => {
    const result = normalizeTransactionStatusResult(DarajaResult.parse(fixture('transaction-status-result-not-found').payload))
    expect(result).toMatchObject({ succeeded: false, resultCode: '2032', receiptNumber: null, amountMinor: null, transactionStatus: null })
  })

  it('parses the synchronous acknowledgement', () => {
    expect(AsyncRequestResponse.parse(fixture('transaction-status-accepted').payload).ConversationID).toBe('AG_20210709_1234409f86436c583e3f')
  })
})

describe('Account Balance result', () => {
  it('normalizes the documented sample with signed amounts', () => {
    const result = normalizeAccountBalanceResult(DarajaResult.parse(fixture('account-balance-result').payload))
    expect(result.succeeded).toBe(true)
    expect(result.completedAt?.toISOString()).toBe('2020-01-09T09:57:10.000Z')
    expect(result.accounts.map((a) => [a.name, a.available])).toEqual([
      ['Working Account', 70_000_000n],
      ['Float Account', 0n],
      ['Utility Account', 22_803_700n],
      ['Charges Paid Account', -154_000n],
      ['Organization Settlement Account', 0n],
    ])
  })

  it('rejects malformed entries', () => {
    expect(() => parseAccountBalance('Utility Account|KES|12.00')).toThrow(/unexpected account balance entry/)
    expect(() => parseAccountBalance('Utility Account|KES|1.234|0|0|0')).toThrow()
  })
})

describe('Pull Transactions', () => {
  it('parses the documented response and skips its unrealistic receipt', () => {
    const response = PullResponse.parse(fixture('pull-response').payload)
    const [record] = response.Response.flat()
    expect(record?.amount).toBe('168.00')
    expect(() => normalizePullRecord(record ?? { transactionId: '', trxDate: '', transactiontype: '', billreference: '', amount: '0' }, '600000')).toThrow(/receipt number/)
  })

  it('normalizes a record', () => {
    const payment = normalizePullRecord(
      { transactionId: 'RKL51ZDR9Z', trxDate: '2026-09-28T07:13:00Z', msisdn: '2547 ***** 126', transactiontype: 'c2b-pay-bill-debit', billreference: 'INV-9', amount: '250.50' },
      '600984',
    )
    expect(payment).toEqual({
      receiptNumber: 'RKL51ZDR9Z',
      amountMinor: 25_050n,
      transactedAt: new Date('2026-09-28T07:13:00Z'),
      billRefNumber: 'INV-9',
      payerName: null,
      msisdn: '2547 ***** 126',
      shortcode: '600984',
    })
  })

  it('dates: zone-less values are EAT, ISO values keep their zone', () => {
    expect(parsePullDate('2026-09-28 10:13:00').toISOString()).toBe('2026-09-28T07:13:00.000Z')
    expect(parsePullDate('2019-07-31 19:00').toISOString()).toBe('2019-07-31T16:00:00.000Z')
    expect(parsePullDate('2020-08-05T10:13:00Z').toISOString()).toBe('2020-08-05T10:13:00.000Z')
    expect(parsePullDate('2020-08-05T10:13:00').toISOString()).toBe('2020-08-05T07:13:00.000Z')
    expect(() => parsePullDate('05/08/2020 10:13')).toThrow()
    expect(formatPullDate(new Date('2026-09-28T07:13:05Z'))).toBe('2026-09-28 10:13:05')
  })
})

describe('security credential', () => {
  it('encrypts with the sandbox certificate (RSA-2048, fresh padding each time)', () => {
    const cert = darajaCertificate('sandbox')
    const a = createSecurityCredential('Safaricom-test', cert)
    const b = createSecurityCredential('Safaricom-test', cert)
    expect(Buffer.from(a, 'base64')).toHaveLength(256)
    expect(a).not.toBe(b)
    expect(a).not.toContain('Safaricom-test')
  })
})

describe('client requests', () => {
  const tokens = new Map<string, CachedToken>()
  const store: TokenStore = {
    read: (id) => Promise.resolve(tokens.get(id) ?? null),
    write: (id, token) => Promise.resolve(void tokens.set(id, token)),
    withLock: (_id, fn) => fn(),
  }
  const bodies: Array<{ path: string; body: Record<string, unknown> }> = []
  const fetchImpl = (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : input.toString()).pathname
    if (path.startsWith('/oauth')) return Promise.resolve(Response.json({ access_token: 'token-xxxxxxxxxxxx', expires_in: '3599' }))
    bodies.push({ path, body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown> })
    if (path.startsWith('/pulltransactions')) return Promise.resolve(Response.json({ ResponseCode: '1001', ResponseMessage: 'No transactions' }))
    return Promise.resolve(Response.json(fixture('transaction-status-accepted').payload))
  }
  const client = new DarajaClient({
    environment: 'sandbox',
    credentialId: 'test',
    credentials: { consumerKey: 'key', consumerSecret: 'secret', passkey: 'passkey' },
    tokenStore: store,
    logger: { info: () => undefined, warn: () => undefined },
    fetch: fetchImpl,
    initiator: { name: 'testapi', securityCredential: 'ENCRYPTED' },
  })
  const urls = { resultUrl: 'https://example.test/hooks/result/txn/s3cret', timeoutUrl: 'https://example.test/hooks/timeout/txn/s3cret' }

  it('sends Transaction Status, Account Balance and Pull as documented', async () => {
    await client.transactionStatus({ shortcode: '600984', receiptNumber: 'RKL51ZDR4F', ...urls })
    await client.accountBalance({ shortcode: '600984', ...urls })
    const pulled = await client.pullTransactions({ shortcode: '600984', start: new Date('2026-09-28T06:00:00Z'), end: new Date('2026-09-28T07:00:00Z'), offset: 0 })
    expect(pulled.Response).toEqual([])
    expect(bodies).toEqual([
      {
        path: '/mpesa/transactionstatus/v1/query',
        body: expect.objectContaining({
          Initiator: 'testapi',
          SecurityCredential: 'ENCRYPTED',
          CommandID: 'TransactionStatusQuery',
          TransactionID: 'RKL51ZDR4F',
          PartyA: '600984',
          IdentifierType: '4',
          ResultURL: urls.resultUrl,
          QueueTimeOutURL: urls.timeoutUrl,
        }) as unknown,
      },
      {
        path: '/mpesa/accountbalance/v1/query',
        body: expect.objectContaining({ CommandID: 'AccountBalance', PartyA: '600984', IdentifierType: '4' }) as unknown,
      },
      {
        path: '/pulltransactions/v1/query',
        body: { ShortCode: '600984', StartDate: '2026-09-28 09:00:00', EndDate: '2026-09-28 10:00:00', OffSetValue: '0' },
      },
    ])
  })

  it('refuses result URLs with banned words', async () => {
    await expect(
      client.transactionStatus({ shortcode: '600984', receiptNumber: 'RKL51ZDR4F', resultUrl: 'https://example.test/mpesa/result', timeoutUrl: urls.timeoutUrl }),
    ).rejects.toThrow(/mpesa/)
  })
})
