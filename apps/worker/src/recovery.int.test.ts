import { ingestC2B, ingestStkCallback } from '@paysync/ingest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { c2bConfirmation, createHarness, pullRecord, stkSuccess, type Harness } from './harness.test.support.js'
import { ingestPullRecord } from './pull.js'
import { sweepPull, sweepStkRequests } from './sweeps.js'

let h: Harness

beforeAll(async () => {
  // No Transaction Status: a pending C2B payment can only be verified by Pull.
  h = await createHarness({ initiator: false })
})

afterAll(async () => {
  await h.close()
})

const postings = (receipt: string) =>
  h.count(
    `ledger.journal j JOIN core.mpesa_transaction t ON t.id = j.transaction_id WHERE t.receipt_number = $1 AND j.kind = 'receipt'`,
    [receipt],
  )

async function transaction(receipt: string) {
  const { rows } = await h.admin.query<{ status: string; source: string; verification_method: string | null; amount: string }>(
    'SELECT status, source, verification_method, amount::text FROM core.mpesa_transaction WHERE receipt_number = $1',
    [receipt],
  )
  return rows
}

describe('missed C2B callback (M3 done-when)', () => {
  it('is recovered by the Pull sweep with exactly one posting, and a late callback changes nothing', async () => {
    // The payment happened but its confirmation never reached us.
    h.fake.pullRecords = [pullRecord('RKL51ZDR9Z', '250.00'), pullRecord('RKL51ZDRA1', '75.00'), pullRecord('RKL51ZDRA2', '10.00')]

    expect(await sweepPull(h.deps)).toBe(1)
    await h.runJobs()
    expect(await transaction('RKL51ZDR9Z')).toEqual([{ status: 'verified', source: 'pull', verification_method: 'pull', amount: '25000' }])
    expect(await postings('RKL51ZDR9Z')).toBe(1)
    expect(h.fake.callsTo('/pulltransactions/v1/query').length).toBeGreaterThanOrEqual(2)

    // The confirmation finally arrives (twice), and the sweep runs again over an overlapping window.
    await ingestC2B(h.ingest, 'c2b_confirmation', c2bConfirmation('RKL51ZDR9Z', '250.00'))
    await ingestC2B(h.ingest, 'c2b_confirmation', c2bConfirmation('RKL51ZDR9Z', '250.00'))
    await sweepPull(h.deps)
    await h.runJobs()

    for (const receipt of ['RKL51ZDR9Z', 'RKL51ZDRA1', 'RKL51ZDRA2']) {
      expect(await h.count('core.mpesa_transaction WHERE receipt_number = $1', [receipt])).toBe(1)
      expect(await postings(receipt)).toBe(1)
    }
    const { rows } = await h.admin.query<{ source: string; n: string }>(
      `SELECT source, count(*)::text AS n FROM ingest.inbound_event WHERE external_id = 'RKL51ZDR9Z' GROUP BY source ORDER BY source`,
    )
    expect(rows).toEqual([
      { source: 'c2b_confirmation', n: '1' },
      { source: 'pull', n: '1' },
    ])
    expect(await h.count('ingest.pull_cursor')).toBe(1)
  })

  it('a pending callback transaction is verified by its Pull record', async () => {
    await ingestC2B(h.ingest, 'c2b_confirmation', c2bConfirmation('RKL51ZDRB1', '40.00'))
    await h.runJobs()
    expect((await transaction('RKL51ZDRB1'))[0]?.status).toBe('pending_verification')
    expect(await postings('RKL51ZDRB1')).toBe(0)

    const target = { orgId: h.orgId, shortcodeId: h.shortcodes.c2b, code: '600984' }
    expect(await ingestPullRecord(h.deps, target, pullRecord('RKL51ZDRB1', '40.00'))).toBe('verified')
    expect(await ingestPullRecord(h.deps, target, pullRecord('RKL51ZDRB1', '40.00'))).toBe('unchanged')
    expect(await transaction('RKL51ZDRB1')).toEqual([{ status: 'verified', source: 'c2b', verification_method: 'pull', amount: '4000' }])
    expect(await postings('RKL51ZDRB1')).toBe(1)
  })

  it('a Pull record with a different amount fails verification: no posting, a high-priority exception', async () => {
    await ingestC2B(h.ingest, 'c2b_confirmation', c2bConfirmation('RKL51ZDRC1', '500.00'))
    const target = { orgId: h.orgId, shortcodeId: h.shortcodes.c2b, code: '600984' }
    expect(await ingestPullRecord(h.deps, target, pullRecord('RKL51ZDRC1', '50.00'))).toBe('failed')
    expect((await transaction('RKL51ZDRC1'))[0]?.status).toBe('verification_failed')
    expect(await postings('RKL51ZDRC1')).toBe(0)
    expect(
      await h.count(
        `core.exception x JOIN core.mpesa_transaction t ON t.id = x.transaction_id WHERE t.receipt_number = 'RKL51ZDRC1' AND x.kind = 'verification_failed' AND x.priority = 'high'`,
      ),
    ).toBe(1)
  })

  it('callback and sweep racing for the same receipts end with one transaction and one posting each', async () => {
    const target = { orgId: h.orgId, shortcodeId: h.shortcodes.c2b, code: '600984' }
    const receipts = Array.from({ length: 6 }, (_, i) => `RKL51ZDRD${i}`)
    await Promise.all(
      receipts.flatMap((r) => [
        ingestC2B(h.ingest, 'c2b_confirmation', c2bConfirmation(r, '20.00')),
        ingestPullRecord(h.deps, target, pullRecord(r, '20.00')),
        ingestPullRecord(h.deps, target, pullRecord(r, '20.00')),
        ingestC2B(h.ingest, 'c2b_confirmation', c2bConfirmation(r, '20.00')),
      ]),
    )
    await h.runJobs()
    for (const r of receipts) {
      const rows = await transaction(r)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.status).toBe('verified')
      expect(await postings(r)).toBe(1)
    }
  })
})

describe('missed STK callback', () => {
  it('the STK sweep finds the push paid and raises missing_callback; Pull then supplies the receipt and one posting', async () => {
    await h.admin.query(
      `INSERT INTO ingest.stk_request (org_id, shortcode_id, checkout_request_id, account_reference, amount, status, created_at)
       VALUES ($1, $2, 'ws_CO_MISSED', 'UNIT-C3', 12000, 'pending', now() - interval '10 minutes')`,
      [h.orgId, h.shortcodes.stk],
    )
    h.fake.stk.set('ws_CO_MISSED', { ResultCode: '0', ResultDesc: 'The service request is processed successfully.' })

    expect(await sweepStkRequests(h.deps)).toBe(1)
    await h.runJobs()
    const { rows } = await h.admin.query<{ status: string }>(`SELECT status FROM ingest.stk_request WHERE checkout_request_id = 'ws_CO_MISSED'`)
    expect(rows).toEqual([{ status: 'succeeded' }])
    expect(await h.count(`core.exception WHERE kind = 'missing_callback' AND priority = 'high'`)).toBe(1)
    expect(await sweepStkRequests(h.deps)).toBe(0)

    const target = { orgId: h.orgId, shortcodeId: h.shortcodes.stk, code: '174379' }
    expect(await ingestPullRecord(h.deps, target, pullRecord('RKL51ZDRE1', '120.00', 'UNIT-C3'))).toBe('created')
    expect(await postings('RKL51ZDRE1')).toBe(1)
  })

  it('a callback that arrived before its CheckoutRequestID was saved is re-routed by the STK check', async () => {
    // Stored as unrouted: no stk_request knows this checkout yet.
    await ingestStkCallback(h.ingest, stkSuccess('ws_CO_EARLY', 'RKL51ZDRF1', 30))
    expect(await h.count(`ingest.unrouted_event WHERE external_id = 'ws_CO_EARLY'`)).toBe(1)

    await h.admin.query(
      `INSERT INTO ingest.stk_request (org_id, shortcode_id, checkout_request_id, account_reference, amount, status, created_at)
       VALUES ($1, $2, 'ws_CO_EARLY', 'UNIT-C4', 3000, 'pending', now() - interval '10 minutes')`,
      [h.orgId, h.shortcodes.stk],
    )
    h.fake.stk.set('ws_CO_EARLY', { ResultCode: '0', ResultDesc: 'The service request is processed successfully.' })
    expect(await sweepStkRequests(h.deps)).toBe(1)
    await h.runJobs()

    expect(await transaction('RKL51ZDRF1')).toEqual([{ status: 'verified', source: 'stk', verification_method: 'stk_query', amount: '3000' }])
    expect(await postings('RKL51ZDRF1')).toBe(1)
    expect(await h.count(`core.exception WHERE kind = 'missing_callback' AND details->>'checkoutRequestId' = 'ws_CO_EARLY'`)).toBe(0)
  })
})
