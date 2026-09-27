import { ingestC2B, ingestDarajaResult, ingestStkCallback } from '@paysync/ingest'
import type { Job } from 'graphile-worker'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  balanceResult,
  c2bConfirmation,
  createHarness,
  stkSuccess,
  transactionStatusResult,
  type DarajaCall,
  type Harness,
} from './harness.test.support.js'
import { sweepBalances, sweepUnverified } from './sweeps.js'
import { reportFailedJob } from './tasks.js'
import { verifyTransaction } from './verify.js'

let h: Harness

beforeAll(async () => {
  h = await createHarness({ policy: { maxAttempts: 3 } })
})

afterAll(async () => {
  await h.close()
})

const postings = (receipt: string) =>
  h.count(`ledger.journal j JOIN core.mpesa_transaction t ON t.id = j.transaction_id WHERE t.receipt_number = $1`, [receipt])

async function status(receipt: string) {
  const { rows } = await h.admin.query<{ id: string; status: string; verification_method: string | null }>(
    'SELECT id, status, verification_method FROM core.mpesa_transaction WHERE receipt_number = $1',
    [receipt],
  )
  return rows[0]
}

async function requestFor(receipt: string) {
  const { rows } = await h.admin.query<{ status: string; originator_conversation_id: string; conversation_id: string }>(
    `SELECT r.status, r.originator_conversation_id, r.conversation_id FROM ingest.daraja_request r
     JOIN core.mpesa_transaction t ON t.id = r.transaction_id WHERE t.receipt_number = $1 ORDER BY r.created_at`,
    [receipt],
  )
  return rows
}

const ids = (r: { originator_conversation_id: string; conversation_id: string } | undefined) => ({
  OriginatorConversationID: r?.originator_conversation_id ?? '',
  ConversationID: r?.conversation_id ?? '',
})

describe('C2B verification via Transaction Status', () => {
  it('confirmation → Transaction Status → matching result → verified with one posting', async () => {
    await ingestC2B(h.ingest, 'c2b_confirmation', c2bConfirmation('RKL51ZDRG1', '250.00'))
    await h.runJobs()
    const [request] = await requestFor('RKL51ZDRG1')
    expect(request?.status).toBe('accepted')
    const call = h.fake.callsTo('/mpesa/transactionstatus/v1/query').at(-1)
    expect(call?.body).toMatchObject({ TransactionID: 'RKL51ZDRG1', PartyA: '600984', ResultURL: expect.stringMatching(/\/hooks\/result\/txn\//) as unknown })

    const result = transactionStatusResult(ids(request), { receipt: 'RKL51ZDRG1', amount: '250.00' })
    await ingestDarajaResult(h.ingest, 'result', 'transaction_status', result)
    await ingestDarajaResult(h.ingest, 'result', 'transaction_status', result)
    await h.runJobs()

    expect(await status('RKL51ZDRG1')).toMatchObject({ status: 'verified', verification_method: 'transaction_status' })
    expect(await postings('RKL51ZDRG1')).toBe(1)
    expect((await requestFor('RKL51ZDRG1'))[0]?.status).toBe('completed')
    // The payer's name inside the result is sealed at rest.
    const { rows } = await h.admin.query<{ payload: string }>(
      `SELECT payload::text FROM ingest.inbound_event WHERE source = 'transaction_status_result' AND external_id = $1`,
      [request?.conversation_id],
    )
    expect(rows[0]?.payload).not.toContain('John Doe')
  })

  it('a result that disagrees (amount) fails verification with no posting', async () => {
    await ingestC2B(h.ingest, 'c2b_confirmation', c2bConfirmation('RKL51ZDRG2', '900.00'))
    await h.runJobs()
    const [request] = await requestFor('RKL51ZDRG2')
    await ingestDarajaResult(h.ingest, 'result', 'transaction_status', transactionStatusResult(ids(request), { receipt: 'RKL51ZDRG2', amount: '9.00' }))
    await h.runJobs()
    expect((await status('RKL51ZDRG2'))?.status).toBe('verification_failed')
    expect(await postings('RKL51ZDRG2')).toBe(0)
    const { rows } = await h.admin.query<{ priority: string; details: { problems: string[] } }>(
      `SELECT x.priority, x.details FROM core.exception x JOIN core.mpesa_transaction t ON t.id = x.transaction_id
       WHERE t.receipt_number = 'RKL51ZDRG2' AND x.kind = 'verification_failed'`,
    )
    expect(rows).toEqual([{ priority: 'high', details: expect.objectContaining({ problems: ['amount 900 ≠ 90000'] }) as unknown }])
  })

  it('a result credited to another shortcode, or not Completed, fails verification', async () => {
    await ingestC2B(h.ingest, 'c2b_confirmation', c2bConfirmation('RKL51ZDRG3', '5.00'))
    await h.runJobs()
    const [request] = await requestFor('RKL51ZDRG3')
    await ingestDarajaResult(
      h.ingest,
      'result',
      'transaction_status',
      transactionStatusResult(ids(request), { receipt: 'RKL51ZDRG3', amount: '5.00', credit: '999999 - Someone Else', status: 'Declined' }),
    )
    await h.runJobs()
    expect((await status('RKL51ZDRG3'))?.status).toBe('verification_failed')
  })

  it('a result that arrives before the ConversationID is saved is re-routed', async () => {
    h.fake.onAsyncRequest = async (call: DarajaCall, conversation) => {
      if (call.body.TransactionID !== 'RKL51ZDRG4') return
      const early = await ingestDarajaResult(h.ingest, 'result', 'transaction_status', transactionStatusResult(conversation, { receipt: 'RKL51ZDRG4', amount: '15.00' }))
      expect(early.routed).toBe(false)
    }
    try {
      await ingestC2B(h.ingest, 'c2b_confirmation', c2bConfirmation('RKL51ZDRG4', '15.00'))
      await h.runJobs()
    } finally {
      h.fake.onAsyncRequest = null
    }
    expect(await h.count(`ingest.unrouted_event WHERE reason = 'unknown_conversation'`)).toBe(1)
    expect(await status('RKL51ZDRG4')).toMatchObject({ status: 'verified', verification_method: 'transaction_status' })
    expect(await postings('RKL51ZDRG4')).toBe(1)
  })

  it('a queue timeout leaves the payment pending; the sweep asks again later', async () => {
    await ingestC2B(h.ingest, 'c2b_confirmation', c2bConfirmation('RKL51ZDRG5', '60.00'))
    await h.runJobs()
    const [first] = await requestFor('RKL51ZDRG5')
    await ingestDarajaResult(h.ingest, 'timeout', 'transaction_status', { Result: ids(first) })
    await h.runJobs()
    expect((await requestFor('RKL51ZDRG5'))[0]?.status).toBe('timed_out')
    expect((await status('RKL51ZDRG5'))?.status).toBe('pending_verification')

    h.advance(60 * 60_000)
    try {
      expect(await sweepUnverified(h.deps)).toBeGreaterThanOrEqual(1)
      await h.runJobs()
    } finally {
      h.advance(-60 * 60_000)
    }
    const requests = await requestFor('RKL51ZDRG5')
    expect(requests.map((r) => r.status)).toEqual(['timed_out', 'accepted'])
  })

  it('a non-success result code says nothing about the payment: it stays pending until attempts run out', async () => {
    await ingestC2B(h.ingest, 'c2b_confirmation', c2bConfirmation('RKL51ZDRG6', '70.00'))
    await h.runJobs()
    const [request] = await requestFor('RKL51ZDRG6')
    await ingestDarajaResult(h.ingest, 'result', 'transaction_status', transactionStatusResult(ids(request), { receipt: 'RKL51ZDRG6', amount: '70.00', resultCode: 2001 }))
    await h.runJobs()
    expect((await status('RKL51ZDRG6'))?.status).toBe('pending_verification')
    expect(await postings('RKL51ZDRG6')).toBe(0)

    const id = (await status('RKL51ZDRG6'))?.id ?? ''
    // Attempt 1 was the first run; the policy allows 3.
    await h.admin.query(`UPDATE ingest.daraja_request SET status = 'failed', version = version + 1 WHERE transaction_id = $1`, [id])
    await verifyTransaction(h.deps, { orgId: h.orgId, transactionId: id })
    await h.admin.query(`UPDATE ingest.daraja_request SET status = 'failed', version = version + 1 WHERE transaction_id = $1 AND status <> 'failed'`, [id])
    await verifyTransaction(h.deps, { orgId: h.orgId, transactionId: id })
    expect(await h.count(`core.exception WHERE transaction_id = $1 AND kind = 'verification_failed' AND priority = 'normal'`, [id])).toBe(1)
    expect((await status('RKL51ZDRG6'))?.status).toBe('pending_verification')

    h.advance(60 * 60_000)
    try {
      await sweepUnverified(h.deps)
      await h.runJobs()
    } finally {
      h.advance(-60 * 60_000)
    }
    expect((await requestFor('RKL51ZDRG6')).length).toBe(3)
  })
})

describe('STK verification via STK Query', () => {
  async function push(checkout: string, amountMinor: number) {
    await h.admin.query(
      `INSERT INTO ingest.stk_request (org_id, shortcode_id, checkout_request_id, account_reference, amount, status)
       VALUES ($1, $2, $3, 'UNIT-S', $4, 'pending')`,
      [h.orgId, h.shortcodes.stk, checkout, amountMinor],
    )
  }

  it('success callback + STK Query 0 + requested amount → verified once, even with concurrent verifications', async () => {
    await push('ws_CO_S1', 4500)
    h.fake.stk.set('ws_CO_S1', { ResultCode: '0', ResultDesc: 'The service request is processed successfully.' })
    await ingestStkCallback(h.ingest, stkSuccess('ws_CO_S1', 'RKL51ZDRH1', 45))
    const id = (await status('RKL51ZDRH1'))?.id ?? ''
    const outcomes = await Promise.allSettled(Array.from({ length: 4 }, () => verifyTransaction(h.deps, { orgId: h.orgId, transactionId: id })))
    await h.runJobs()
    expect(outcomes.filter((o) => o.status === 'fulfilled' && o.value === 'verified')).toHaveLength(1)
    expect(await status('RKL51ZDRH1')).toMatchObject({ status: 'verified', verification_method: 'stk_query' })
    expect(await postings('RKL51ZDRH1')).toBe(1)
  })

  it('STK Query says cancelled → verification_failed, no posting', async () => {
    await push('ws_CO_S2', 1000)
    h.fake.stk.set('ws_CO_S2', { ResultCode: '1032', ResultDesc: 'Request Cancelled by user.' })
    await ingestStkCallback(h.ingest, stkSuccess('ws_CO_S2', 'RKL51ZDRH2', 10))
    await h.runJobs()
    expect((await status('RKL51ZDRH2'))?.status).toBe('verification_failed')
    expect(await postings('RKL51ZDRH2')).toBe(0)
  })

  it('a callback amount different from the push fails verification (STK Query confirms only what we asked for)', async () => {
    await push('ws_CO_S3', 1000)
    h.fake.stk.set('ws_CO_S3', { ResultCode: '0', ResultDesc: 'The service request is processed successfully.' })
    await ingestStkCallback(h.ingest, stkSuccess('ws_CO_S3', 'RKL51ZDRH3', 100))
    await h.runJobs()
    expect((await status('RKL51ZDRH3'))?.status).toBe('verification_failed')
    expect(await h.count(`core.exception x JOIN core.mpesa_transaction t ON t.id = x.transaction_id WHERE t.receipt_number = 'RKL51ZDRH3'`)).toBe(2)
  })

  it('still pending at M-Pesa → stays pending', async () => {
    await push('ws_CO_S4', 1000)
    h.fake.stk.set('ws_CO_S4', { ResultCode: '4999', ResultDesc: 'The transaction is still under processing' })
    await ingestStkCallback(h.ingest, stkSuccess('ws_CO_S4', 'RKL51ZDRH4', 10))
    await h.runJobs()
    expect((await status('RKL51ZDRH4'))?.status).toBe('pending_verification')
  })
})

describe('account balance', () => {
  it('stores snapshots and raises a variance when the balance moves more than verified receipts explain', async () => {
    const answer = async (utility: string, completed: string) => {
      await sweepBalances(h.deps)
      await h.runJobs()
      const { rows } = await h.admin.query<{ originator_conversation_id: string; conversation_id: string }>(
        `SELECT originator_conversation_id, conversation_id FROM ingest.daraja_request WHERE kind = 'account_balance' ORDER BY created_at DESC LIMIT 1`,
      )
      await ingestDarajaResult(h.ingest, 'result', 'account_balance', balanceResult(ids(rows[0]), utility, completed))
      await h.runJobs()
    }
    await answer('1000.00', '20260101000000')
    expect(await h.count('core.balance_snapshot')).toBe(1)
    expect(await h.count(`core.exception WHERE kind = 'balance_variance'`)).toBe(0)

    await answer('1000.00', '20260102000000')
    expect(await h.count(`core.exception WHERE kind = 'balance_variance'`)).toBe(0)

    await answer('1500.00', '20260103000000')
    const { rows } = await h.admin.query<{ priority: string; details: { varianceMinor: string } }>(
      `SELECT priority, details FROM core.exception WHERE kind = 'balance_variance'`,
    )
    expect(rows).toEqual([{ priority: 'high', details: expect.objectContaining({ varianceMinor: '50000' }) as unknown }])
    expect(h.fake.callsTo('/mpesa/accountbalance/v1/query')).toHaveLength(3)
  })
})

describe('failed jobs', () => {
  it('a job out of retries becomes a job_failed exception, once', async () => {
    const job = { id: '42', task_identifier: 'verify_transaction', attempts: 8, max_attempts: 8, payload: { orgId: h.orgId } } as Partial<Job>
    await reportFailedJob(h.deps, job as Job, new Error('Daraja unavailable'))
    await reportFailedJob(h.deps, job as Job, new Error('Daraja unavailable'))
    expect(await h.count(`core.exception WHERE kind = 'job_failed' AND priority = 'high'`)).toBe(1)
  })
})
