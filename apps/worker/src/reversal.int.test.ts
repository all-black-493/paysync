import { ingestDarajaResult } from '@paysync/ingest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from './harness.test.support.js'
import { executeReversal } from './reversal.js'

let h: Harness

beforeAll(async () => {
  h = await createHarness()
})

afterAll(async () => {
  await h.close()
})

let counter = 0

/** A verified payment with an approved reversal waiting to be sent (what approvals.decide leaves behind). */
async function approvedReversal(amountMinor: number) {
  const receipt = `RKLREV${String(++counter).padStart(4, '0')}`
  const { rows } = await h.admin.query<{ id: string }>(
    `INSERT INTO core.mpesa_transaction (org_id, shortcode_id, receipt_number, amount, transacted_at, source, status, verified_at)
     VALUES ($1, $2, $3, $4, now(), 'c2b', 'verified', now()) RETURNING id`,
    [h.orgId, h.shortcodes.c2b, receipt, amountMinor],
  )
  const transactionId = rows[0]?.id ?? ''
  const { rows: requests } = await h.admin.query<{ id: string }>(
    `INSERT INTO ingest.daraja_request (org_id, shortcode_id, kind, transaction_id, receipt_number) VALUES ($1, $2, 'reversal', $3, $4) RETURNING id`,
    [h.orgId, h.shortcodes.c2b, transactionId, receipt],
  )
  return { transactionId, receipt, darajaRequestId: requests[0]?.id ?? '' }
}

async function request(id: string) {
  const { rows } = await h.admin.query<{ status: string; originator_conversation_id: string | null; conversation_id: string | null }>(
    'SELECT status, originator_conversation_id, conversation_id FROM ingest.daraja_request WHERE id = $1',
    [id],
  )
  return rows[0]
}

const status = async (transactionId: string) =>
  (await h.admin.query<{ status: string }>('SELECT status FROM core.mpesa_transaction WHERE id = $1', [transactionId])).rows[0]?.status

const reversalExceptions = (transactionId: string) =>
  h.count(`core.exception WHERE transaction_id = $1 AND kind = 'reversal_failed' AND priority = 'high'`, [transactionId])

function reversalResult(ids: { originator_conversation_id: string | null; conversation_id: string | null }, fields: { receipt: string; amount: number; code?: number | string; desc?: string }) {
  return {
    Result: {
      ResultType: 0,
      ResultCode: fields.code ?? 0,
      ResultDesc: fields.desc ?? 'The service request is processed successfully.',
      OriginatorConversationID: ids.originator_conversation_id ?? '',
      ConversationID: ids.conversation_id ?? '',
      TransactionID: 'SKE52PAWR9',
      ResultParameters: {
        ResultParameter: [
          { Key: 'Amount', Value: fields.amount },
          { Key: 'OriginalTransactionID', Value: fields.receipt },
          { Key: 'TransCompletedTime', Value: 20260928132711 },
          { Key: 'CreditPartyPublicName', Value: '254705912645 - NICHOLAS JOHN' },
        ],
      },
    },
  }
}

describe('sending an approved reversal', () => {
  it('sends it once with the documented fields, then a confirmed result reverses the payment and the ledger', async () => {
    const r = await approvedReversal(2500)
    await executeReversal(h.deps, { orgId: h.orgId, darajaRequestId: r.darajaRequestId })
    await executeReversal(h.deps, { orgId: h.orgId, darajaRequestId: r.darajaRequestId })
    const calls = h.fake.callsTo('/mpesa/reversal/v1/request')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.body).toMatchObject({
      CommandID: 'TransactionReversal',
      TransactionID: r.receipt,
      Amount: '25',
      ReceiverParty: '600984',
      RecieverIdentifierType: '11',
      ResultURL: expect.stringMatching(/\/hooks\/result\/reversal\//) as unknown,
    })
    const sent = await request(r.darajaRequestId)
    expect(sent?.status).toBe('accepted')
    expect(await status(r.transactionId)).toBe('verified')

    await ingestDarajaResult(h.ingest, 'result', 'reversal', reversalResult(sent ?? { originator_conversation_id: null, conversation_id: null }, { receipt: r.receipt, amount: 25 }))
    await h.runJobs()
    expect(await status(r.transactionId)).toBe('reversed')
    expect((await request(r.darajaRequestId))?.status).toBe('completed')
    const { rows } = await h.admin.query<{ code: string; amount: string }>(
      `SELECT a.code, en.amount::text FROM ledger.journal j JOIN ledger.entry en ON en.journal_id = j.id JOIN ledger.account a ON a.id = en.account_id
       WHERE j.idempotency_key = $1 ORDER BY a.code`,
      [`reversal:${r.transactionId}`],
    )
    expect(rows).toEqual([
      { code: 'mpesa_float', amount: '-2500' },
      { code: 'suspense', amount: '2500' },
    ])
    // The payer's name in the result is sealed at rest.
    const { rows: stored } = await h.admin.query<{ payload: string }>(`SELECT payload::text FROM ingest.inbound_event WHERE source = 'reversal_result' AND external_id = $1`, [sent?.conversation_id])
    expect(stored[0]?.payload).not.toContain('NICHOLAS')
  })

  it('M-Pesa refusing it, or a result for something else, leaves the payment and asks a person', async () => {
    const refused = await approvedReversal(1000)
    await executeReversal(h.deps, { orgId: h.orgId, darajaRequestId: refused.darajaRequestId })
    const refusedIds = await request(refused.darajaRequestId)
    await ingestDarajaResult(
      h.ingest,
      'result',
      'reversal',
      reversalResult(refusedIds ?? { originator_conversation_id: null, conversation_id: null }, { receipt: refused.receipt, amount: 10, code: 'R000002', desc: 'The OriginalTransactionID is invalid.' }),
    )
    const other = await approvedReversal(1000)
    await executeReversal(h.deps, { orgId: h.orgId, darajaRequestId: other.darajaRequestId })
    const otherIds = await request(other.darajaRequestId)
    await ingestDarajaResult(h.ingest, 'result', 'reversal', reversalResult(otherIds ?? { originator_conversation_id: null, conversation_id: null }, { receipt: 'RKLREV9999', amount: 10 }))
    await h.runJobs()
    for (const r of [refused, other]) {
      expect(await status(r.transactionId)).toBe('verified')
      expect(await reversalExceptions(r.transactionId)).toBe(1)
    }
  })

  it('a timeout leaves the outcome unknown: a person checks', async () => {
    const r = await approvedReversal(700)
    await executeReversal(h.deps, { orgId: h.orgId, darajaRequestId: r.darajaRequestId })
    const ids = await request(r.darajaRequestId)
    await ingestDarajaResult(h.ingest, 'timeout', 'reversal', { Result: { OriginatorConversationID: ids?.originator_conversation_id, ConversationID: ids?.conversation_id } })
    await h.runJobs()
    expect((await request(r.darajaRequestId))?.status).toBe('timed_out')
    expect(await reversalExceptions(r.transactionId)).toBe(1)
  })

  it('a failed call is never retried; the unknown outcome goes to a person', async () => {
    const r = await approvedReversal(900)
    const before = h.fake.callsTo('/mpesa/reversal/v1/request').length
    h.fake.failing.add('/mpesa/reversal/v1/request')
    try {
      await executeReversal(h.deps, { orgId: h.orgId, darajaRequestId: r.darajaRequestId })
      await executeReversal(h.deps, { orgId: h.orgId, darajaRequestId: r.darajaRequestId })
    } finally {
      h.fake.failing.delete('/mpesa/reversal/v1/request')
    }
    expect(h.fake.callsTo('/mpesa/reversal/v1/request').length - before).toBe(1)
    expect((await request(r.darajaRequestId))?.status).toBe('failed')
    expect(await reversalExceptions(r.transactionId)).toBe(1)
  })
})

describe('without an initiator', () => {
  it('nothing is sent and a person is told', async () => {
    const noInitiator = await createHarness({ initiator: false })
    try {
      const { rows } = await noInitiator.admin.query<{ id: string }>(
        `INSERT INTO core.mpesa_transaction (org_id, shortcode_id, receipt_number, amount, transacted_at, source, status, verified_at)
         VALUES ($1, $2, 'RKLREVNONE', 500, now(), 'c2b', 'verified', now()) RETURNING id`,
        [noInitiator.orgId, noInitiator.shortcodes.c2b],
      )
      const { rows: requests } = await noInitiator.admin.query<{ id: string }>(
        `INSERT INTO ingest.daraja_request (org_id, shortcode_id, kind, transaction_id, receipt_number) VALUES ($1, $2, 'reversal', $3, 'RKLREVNONE') RETURNING id`,
        [noInitiator.orgId, noInitiator.shortcodes.c2b, rows[0]?.id],
      )
      await executeReversal(noInitiator.deps, { orgId: noInitiator.orgId, darajaRequestId: requests[0]?.id ?? '' })
      expect(noInitiator.fake.callsTo('/mpesa/reversal/v1/request')).toHaveLength(0)
      expect(await noInitiator.count(`core.exception WHERE kind = 'reversal_failed'`)).toBe(1)
    } finally {
      await noInitiator.close()
    }
  })
})
