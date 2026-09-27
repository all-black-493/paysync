import { asOrg, createOrganization, createTestDatabase, type TestDatabase } from '@paysync/test-utils'
import fc from 'fast-check'
import { sql } from 'drizzle-orm'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AllocationError, allocate } from './allocation.js'
import { createDb, type Db } from './client.js'
import { match } from './schema/core.js'
import { LedgerError, postJournal } from './ledger.js'
import { pgErrorCode, withOrg, type Tx } from './tenancy.js'

let db: TestDatabase
let admin: pg.Pool
let app: pg.Pool
let appDb: Db
let orgA: string
let orgB: string

interface OrgFixture {
  readonly shortcodeId: string
  readonly cash: string
  readonly receivable: string
}
const fixtures = new Map<string, OrgFixture>()

async function fixture(orgId: string, code: string): Promise<OrgFixture> {
  const { rows: sc } = await admin.query<{ id: string }>(
    `INSERT INTO core.shortcode (org_id, code, kind, environment) VALUES ($1, $2, 'paybill', 'sandbox') RETURNING id`,
    [orgId, code],
  )
  const { rows: accts } = await admin.query<{ id: string; code: string }>(
    `INSERT INTO ledger.account (org_id, code, name, kind) VALUES ($1, 'cash', 'M-Pesa float', 'asset'),
     ($1, 'receivable', 'Receivables', 'asset') RETURNING id, code`,
    [orgId],
  )
  const byCode = (c: string) => accts.find((a) => a.code === c)?.id ?? ''
  return { shortcodeId: sc[0]?.id ?? '', cash: byCode('cash'), receivable: byCode('receivable') }
}

function fx(orgId: string): OrgFixture {
  const f = fixtures.get(orgId)
  if (!f) throw new Error('missing fixture')
  return f
}

let receiptSeq = 0
async function transaction(orgId: string, amount: bigint): Promise<string> {
  receiptSeq++
  const receipt = `TX${String(receiptSeq).padStart(8, '0')}`
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO core.mpesa_transaction (org_id, shortcode_id, receipt_number, amount, transacted_at, source)
     VALUES ($1, $2, $3, $4, now(), 'c2b') RETURNING id`,
    [orgId, fx(orgId).shortcodeId, receipt, amount.toString()],
  )
  return rows[0]?.id ?? ''
}

async function expected(orgId: string, reference: string, amount: bigint): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO core.expected_payment (org_id, reference, reference_normalized, amount_due)
     VALUES ($1, $2, $2, $3) RETURNING id`,
    [orgId, reference, amount.toString()],
  )
  return rows[0]?.id ?? ''
}

async function newMatch(client: pg.PoolClient, orgId: string, transactionId: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO core.match (org_id, transaction_id, method) VALUES ($1, $2, 'manual') RETURNING id`,
    [orgId, transactionId],
  )
  return rows[0]?.id ?? ''
}

async function newMatchTx(tx: Tx, orgId: string, transactionId: string): Promise<string> {
  const [row] = await tx.insert(match).values({ orgId, transactionId, method: 'manual' }).returning({ id: match.id })
  return row?.id ?? ''
}

beforeAll(async () => {
  db = await createTestDatabase()
  admin = db.pool('admin')
  app = db.pool('app')
  appDb = createDb(app)
  orgA = await createOrganization(db, 'Acme')
  orgB = await createOrganization(db, 'Beta')
  fixtures.set(orgA, await fixture(orgA, '600100'))
  fixtures.set(orgB, await fixture(orgB, '600200'))
})

afterAll(async () => {
  await db.drop()
})

describe('row-level security', () => {
  it('scopes every read to the org set on the transaction', async () => {
    await transaction(orgA, 1000n)
    await transaction(orgB, 2000n)
    const orgsSeen = async (orgId: string) =>
      asOrg(app, orgId, async (c) => (await c.query<{ org_id: string }>('SELECT DISTINCT org_id FROM core.mpesa_transaction')).rows)
    expect(await orgsSeen(orgA)).toEqual([{ org_id: orgA }])
    expect(await orgsSeen(orgB)).toEqual([{ org_id: orgB }])
  })

  it('is enabled on every table with an org_id', async () => {
    const { rows } = await admin.query<{ table: string; rls: boolean }>(`
      SELECT n.nspname || '.' || c.relname AS table, c.relrowsecurity AS rls
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped
      WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('core', 'ingest', 'ledger', 'agent', 'audit')
      ORDER BY 1`)
    expect(rows.length).toBeGreaterThan(10)
    expect(rows.filter((r) => !r.rls).map((r) => r.table)).toEqual([])
  })

  it('returns nothing when no org is set', async () => {
    const { rows } = await app.query('SELECT 1 FROM core.mpesa_transaction')
    expect(rows).toEqual([])
    const { rows: accounts } = await app.query('SELECT 1 FROM ledger.account')
    expect(accounts).toEqual([])
  })

  it('refuses to write rows for another org', async () => {
    await expect(
      asOrg(app, orgA, (c) =>
        c.query(`INSERT INTO core.expected_payment (org_id, reference, reference_normalized, amount_due) VALUES ($1, 'X1', 'X1', 5)`, [orgB]),
      ),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('cannot move a row to another org', async () => {
    const id = await expected(orgA, 'MOVE-ME', 100n)
    await expect(
      asOrg(app, orgA, (c) => c.query('UPDATE core.expected_payment SET org_id = $1, version = version + 1 WHERE id = $2', [orgB, id])),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('withOrg scopes drizzle queries the same way', async () => {
    const seen = await withOrg(appDb, orgB, async (tx) => {
      const { rows } = await tx.execute<{ org_id: string }>(sql`SELECT DISTINCT org_id FROM ledger.account`)
      return rows
    })
    expect(seen).toEqual([{ org_id: orgB }])
  })
})

describe('append-only tables', () => {
  it('the app role has no UPDATE or DELETE privilege on them', async () => {
    await asOrg(app, orgA, async (c) => {
      await postJournalRaw(c, orgA, 'append-only-1', [100n, -100n])
    })
    for (const table of [
      'ledger.entry',
      'ledger.journal',
      'ledger.account',
      'audit.event',
      'ingest.inbound_event',
      'ingest.unrouted_event',
      'core.allocation',
      'core.balance_snapshot',
    ]) {
      await expect(asOrg(app, orgA, (c) => c.query(`UPDATE ${table} SET id = id`))).rejects.toMatchObject({ code: '42501' })
      await expect(asOrg(app, orgA, (c) => c.query(`DELETE FROM ${table}`))).rejects.toMatchObject({ code: '42501' })
    }
  })

  it('even the superuser is stopped by the trigger', async () => {
    await expect(admin.query('UPDATE ledger.entry SET amount = amount')).rejects.toMatchObject({ code: 'PSA01' })
    await expect(admin.query('DELETE FROM ledger.journal')).rejects.toMatchObject({ code: 'PSA01' })
    await expect(admin.query('TRUNCATE ledger.entry CASCADE')).rejects.toMatchObject({ code: 'PSA01' })
  })
})

async function postJournalRaw(client: pg.PoolClient, orgId: string, key: string, amounts: readonly bigint[]): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO ledger.journal (org_id, kind, description, idempotency_key) VALUES ($1, 'test', 'raw', $2) RETURNING id`,
    [orgId, key],
  )
  const journalId = rows[0]?.id ?? ''
  const { cash, receivable } = fx(orgId)
  for (const [i, amount] of amounts.entries()) {
    await client.query('INSERT INTO ledger.entry (org_id, journal_id, account_id, amount) VALUES ($1, $2, $3, $4)', [
      orgId,
      journalId,
      i % 2 === 0 ? cash : receivable,
      amount.toString(),
    ])
  }
  return journalId
}

describe('ledger balance', () => {
  it('rejects an unbalanced journal at commit, even when code is bypassed', async () => {
    await expect(asOrg(app, orgA, (c) => postJournalRaw(c, orgA, 'unbalanced', [100n, -99n]))).rejects.toMatchObject({
      code: '23514',
      constraint: 'ledger_journal_balanced',
    })
  })

  it('rejects a journal with a single line or no lines', async () => {
    await expect(asOrg(app, orgA, (c) => postJournalRaw(c, orgA, 'one-line', [100n]))).rejects.toMatchObject({ code: '23514' })
    await expect(asOrg(app, orgA, (c) => postJournalRaw(c, orgA, 'no-lines', []))).rejects.toMatchObject({ code: '23514' })
  })

  it('stores random balanced journals and rejects random unbalanced ones (property)', async () => {
    const line = fc.bigInt({ min: 1n, max: 10n ** 12n })
    await fc.assert(
      fc.asyncProperty(fc.array(line, { minLength: 1, maxLength: 6 }), fc.boolean(), async (debits, unbalance) => {
        const credit = -debits.reduce((s, d) => s + d, 0n)
        const amounts = [...debits, unbalance ? credit + 1n : credit]
        const key = `prop-${crypto.randomUUID()}`
        const attempt = asOrg(app, orgA, (c) => postJournalRaw(c, orgA, key, amounts))
        if (unbalance) {
          await expect(attempt).rejects.toMatchObject({ constraint: 'ledger_journal_balanced' })
        } else {
          const journalId = await attempt
          const { rows } = await asOrg(app, orgA, (c) =>
            c.query<{ total: string }>('SELECT sum(amount)::text AS total FROM ledger.entry WHERE journal_id = $1', [journalId]),
          )
          expect(rows[0]?.total).toBe('0')
        }
      }),
      { numRuns: 30 },
    )
  })

  it('every stored journal sums to zero', async () => {
    const { rows } = await admin.query('SELECT journal_id FROM ledger.entry GROUP BY journal_id HAVING sum(amount) <> 0')
    expect(rows).toEqual([])
  })

  it('postJournal is idempotent per key and refuses a different journal under the same key', async () => {
    const { cash, receivable } = fx(orgA)
    const input = {
      orgId: orgA,
      kind: 'receipt',
      description: 'test',
      idempotencyKey: 'post-once',
      lines: [
        { accountId: cash, amount: 500n },
        { accountId: receivable, amount: -500n },
      ],
    }
    const first = await withOrg(appDb, orgA, (tx) => postJournal(tx, input))
    const again = await withOrg(appDb, orgA, (tx) => postJournal(tx, input))
    expect(first.created).toBe(true)
    expect(again).toEqual({ journalId: first.journalId, created: false })

    const different = { ...input, lines: [{ accountId: cash, amount: 600n }, { accountId: receivable, amount: -600n }] }
    await expect(withOrg(appDb, orgA, (tx) => postJournal(tx, different))).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    })
    await expect(
      withOrg(appDb, orgA, (tx) => postJournal(tx, { ...input, idempotencyKey: 'bad', lines: [{ accountId: cash, amount: 1n }] })),
    ).rejects.toBeInstanceOf(LedgerError)
  })

  it('cannot attach an entry to another org’s journal or account', async () => {
    const journalB = await asOrg(app, orgB, (c) => postJournalRaw(c, orgB, 'b-journal', [10n, -10n]))
    await expect(
      admin.query('INSERT INTO ledger.entry (org_id, journal_id, account_id, amount) VALUES ($1, $2, $3, 5)', [
        orgA,
        journalB,
        fx(orgA).cash,
      ]),
    ).rejects.toMatchObject({ code: '23503' })
  })
})

describe('allocation', () => {
  it('allocate() refuses to exceed the transaction amount', async () => {
    const txId = await transaction(orgA, 1_000n)
    const inv1 = await expected(orgA, 'INV-A1', 600n)
    const inv2 = await expected(orgA, 'INV-A2', 600n)
    await withOrg(appDb, orgA, async (tx) => {
      const matchId = await newMatchTx(tx, orgA, txId)
      const plan = await allocate(tx, { orgId: orgA, transactionId: txId, matchId, parts: [{ expectedPaymentId: inv1, amount: 600n }] })
      expect(plan).toEqual({ allocated: 600n, unallocated: 400n })
    })
    await expect(
      withOrg(appDb, orgA, async (tx) => {
        const matchId = await newMatchTx(tx, orgA, txId)
        await allocate(tx, { orgId: orgA, transactionId: txId, matchId, parts: [{ expectedPaymentId: inv2, amount: 600n }] })
      }),
    ).rejects.toBeInstanceOf(AllocationError)
  })

  it('the database rejects over-allocation at commit when code is bypassed', async () => {
    const txId = await transaction(orgA, 1_000n)
    const inv = await expected(orgA, 'INV-A3', 2_000n)
    await expect(
      asOrg(app, orgA, async (c) => {
        const matchId = await newMatch(c, orgA, txId)
        await c.query(
          'INSERT INTO core.allocation (org_id, match_id, transaction_id, expected_payment_id, amount) VALUES ($1, $2, $3, $4, 1001)',
          [orgA, matchId, txId, inv],
        )
      }),
    ).rejects.toMatchObject({ constraint: 'core_allocation_within_amount' })
  })

  it('allocations of unmatched matches no longer count', async () => {
    const txId = await transaction(orgA, 1_000n)
    const inv = await expected(orgA, 'INV-A4', 1_000n)
    const matchId = await asOrg(app, orgA, async (c) => {
      const id = await newMatch(c, orgA, txId)
      await c.query(
        'INSERT INTO core.allocation (org_id, match_id, transaction_id, expected_payment_id, amount) VALUES ($1, $2, $3, $4, 1000)',
        [orgA, id, txId, inv],
      )
      return id
    })
    await asOrg(app, orgA, (c) =>
      c.query(`UPDATE core.match SET status = 'unmatched', unmatched_at = now(), version = version + 1 WHERE id = $1`, [matchId]),
    )
    await withOrg(appDb, orgA, async (tx) => {
      const again = await newMatchTx(tx, orgA, txId)
      await allocate(tx, { orgId: orgA, transactionId: txId, matchId: again, parts: [{ expectedPaymentId: inv, amount: 1_000n }] })
    })
  })

  it('a match cannot be re-activated or rewritten', async () => {
    const txId = await transaction(orgA, 50n)
    const matchId = await asOrg(app, orgA, (c) => newMatch(c, orgA, txId))
    await expect(
      asOrg(app, orgA, (c) => c.query(`UPDATE core.match SET method = 'jev' WHERE id = $1`, [matchId])),
    ).rejects.toMatchObject({ constraint: 'core_match_transition' })
    await expect(asOrg(app, orgA, (c) => c.query('DELETE FROM core.match WHERE id = $1', [matchId]))).rejects.toMatchObject({
      code: '42501',
    })
  })
})

describe('other invariants', () => {
  it('a receipt number is unique per shortcode', async () => {
    const insert = () =>
      admin.query(
        `INSERT INTO core.mpesa_transaction (org_id, shortcode_id, receipt_number, amount, transacted_at, source)
         VALUES ($1, $2, 'SAMERCPT01', 10, now(), 'c2b')`,
        [orgA, fx(orgA).shortcodeId],
      )
    await insert()
    await expect(insert()).rejects.toMatchObject({ code: '23505' })
  })

  it('updates must bump version by exactly one', async () => {
    const id = await expected(orgA, 'VERSIONED', 10n)
    await expect(
      asOrg(app, orgA, (c) => c.query(`UPDATE core.expected_payment SET description = 'x' WHERE id = $1`, [id])),
    ).rejects.toMatchObject({ code: 'PSV01' })
    await asOrg(app, orgA, (c) => c.query(`UPDATE core.expected_payment SET description = 'x', version = version + 1 WHERE id = $1`, [id]))
  })

  it('withOrg retries serialization failures, then gives up', async () => {
    let calls = 0
    const result = await withOrg(
      appDb,
      orgA,
      () => {
        calls++
        if (calls < 3) return Promise.reject(Object.assign(new Error('conflict'), { code: '40001' }))
        return Promise.resolve('done')
      },
      { isolation: 'serializable' },
    )
    expect(result).toBe('done')
    expect(calls).toBe(3)

    const failing = withOrg(appDb, orgA, () => Promise.reject(Object.assign(new Error('conflict'), { code: '40001' })), {
      isolation: 'serializable',
    })
    await expect(failing).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '40001')
  })
})
