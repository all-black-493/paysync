import { normalizeReference } from '@paysync/matching'
import { createTestDatabase, type TestDatabase } from '@paysync/test-utils'
import { isDefinedError, safe } from '@orpc/client'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  addMember,
  createOrg,
  createUser,
  key,
  rest,
  rpcClient,
  signIn,
  startTestApi,
  type TestApi,
  type TestUser,
} from './harness.test.support.js'

let database: TestDatabase
let api: TestApi
let admin: pg.Pool
let orgId: string
let shortcodeId: string
type Name = 'owner' | 'clerk' | 'viewer'
let users!: Record<Name, TestUser>
const cookies = new Map<Name, string>()
const client = (name: Name) => rpcClient(api, cookies.get(name))
const kes = (minor: number) => ({ minor: String(minor), currency: 'KES' as const })

beforeAll(async () => {
  database = await createTestDatabase()
  api = await startTestApi(database)
  admin = database.pool('admin')
  users = { owner: await createUser(api.auth, 'Olga'), clerk: await createUser(api.auth, 'Cleo'), viewer: await createUser(api.auth, 'Vic') }
  orgId = await createOrg(api.auth, 'Acme', users.owner)
  await addMember(api.auth, orgId, users.clerk, 'clerk')
  await addMember(api.auth, orgId, users.viewer, 'viewer')
  for (const [name, user] of Object.entries(users) as Array<[Name, TestUser]>) cookies.set(name, await signIn(api, user))
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO core.shortcode (org_id, code, kind, environment, c2b_enabled) VALUES ($1, '600111', 'paybill', 'sandbox', true) RETURNING id`,
    [orgId],
  )
  shortcodeId = rows[0]?.id ?? ''
})

afterAll(async () => {
  await api.close()
  await database.drop()
})

async function expected(reference: string, amountDue: number): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO core.expected_payment (org_id, reference, reference_normalized, amount_due, due_date) VALUES ($1, $2, $3, $4, current_date) RETURNING id`,
    [orgId, reference, normalizeReference(reference), amountDue],
  )
  return rows[0]?.id ?? ''
}

let receiptCounter = 0
async function payment(amount: number, billRef: string, status: 'verified' | 'pending_verification' = 'verified'): Promise<string> {
  const receipt = `RKL5ZZZZ${String(++receiptCounter).padStart(2, '0')}`
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO core.mpesa_transaction (org_id, shortcode_id, receipt_number, amount, transacted_at, source, bill_ref_number, status, verified_at)
     VALUES ($1, $2, $3, $4, now(), 'c2b', $5, $6, CASE WHEN $6 = 'verified' THEN now() END) RETURNING id`,
    [orgId, shortcodeId, receipt, amount, billRef, status],
  )
  return rows[0]?.id ?? ''
}

async function noMatchException(transactionId: string): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO core.exception (org_id, kind, summary, transaction_id, dedupe_key) VALUES ($1, 'no_match', 'No open expected payment has this reference.', $2, $3) RETURNING id`,
    [orgId, transactionId, `match:${transactionId}`],
  )
  return rows[0]?.id ?? ''
}

describe('matches.suggest', () => {
  it('ranks candidates with reasons and the amount confirming would allocate; changes nothing', async () => {
    const good = await expected('INV-0042', 5000)
    await expected('INV-0999', 5000)
    const t = await payment(5000, 'inv 42')
    const result = await client('viewer').matches.suggest({ transactionId: t })
    expect(result.transaction).toMatchObject({ id: t, unallocated: kes(5000) })
    expect(result.suggestions[0]).toMatchObject({
      expectedPayment: { id: good, reference: 'INV-0042' },
      reasons: ['same_reference_normalized', 'amount_equals_due', 'due_date_near'],
      amount: kes(5000),
    })
    expect(await database.pool('admin').query('SELECT 1 FROM core.match WHERE transaction_id = $1', [t]).then((r) => r.rowCount)).toBe(0)
  })

  it('is scoped to the caller’s organization', async () => {
    const t = await payment(100, 'x')
    const other = await createUser(api.auth, 'Outsider')
    await createOrg(api.auth, 'Other', other)
    const [error] = await safe(rpcClient(api, await signIn(api, other)).matches.suggest({ transactionId: t }))
    expect(error).toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('matches.confirm', () => {
  it('a clerk splits one payment over two expected payments; exceptions close; statuses and the ledger follow', async () => {
    const a = await expected('RENT-B2-OCT', 3000)
    const b = await expected('WATER-B2-OCT', 2000)
    const t = await payment(6000, 'house b2')
    const exceptionId = await noMatchException(t)
    const { version } = await client('clerk').transactions.get({ id: t })

    const preview = await client('clerk').matches.confirm({
      transactionId: t,
      version,
      allocations: [
        { expectedPaymentId: a, amount: kes(3000) },
        { expectedPaymentId: b, amount: kes(2000) },
      ],
      idempotencyKey: key('dry'),
      dryRun: true,
    })
    expect(preview).toMatchObject({ dryRun: true, changed: true, result: { method: 'manual', allocations: [expect.anything(), expect.anything()] } })
    expect((await client('clerk').transactions.get({ id: t })).allocated).toEqual(kes(0))

    const idempotencyKey = key('confirm')
    const input = {
      transactionId: t,
      version,
      allocations: [
        { expectedPaymentId: a, amount: kes(3000) },
        { expectedPaymentId: b, amount: kes(2000) },
      ],
      idempotencyKey,
    }
    const done = await client('clerk').matches.confirm(input)
    expect(done).toMatchObject({ dryRun: false, changed: true, result: { transactionId: t, method: 'manual', status: 'active' } })
    expect(await client('clerk').matches.confirm(input)).toEqual(done)

    expect(await client('clerk').transactions.get({ id: t })).toMatchObject({ allocated: kes(5000), unallocated: kes(1000) })
    expect(await client('clerk').expected.get({ id: a })).toMatchObject({ status: 'paid', amountPaid: kes(3000) })
    expect(await client('clerk').expected.get({ id: b })).toMatchObject({ status: 'paid', amountPaid: kes(2000) })
    expect(await client('clerk').exceptions.get({ id: exceptionId })).toMatchObject({ status: 'resolved', note: 'Matched by hand.' })
    const { rows } = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ledger.journal WHERE transaction_id = $1 AND kind = 'allocation'`,
      [t],
    )
    expect(rows[0]?.n).toBe('1')
  })

  it('rejects a stale version, amounts that do not fit, unverified payments and closed expected payments', async () => {
    const e = await expected('INV-8001', 1000)
    const t = await payment(1500, 'INV-8001')
    const { version } = await client('clerk').transactions.get({ id: t })
    const confirm = (amount: number, v = version, expectedPaymentId = e, transactionId = t) =>
      safe(client('clerk').matches.confirm({ transactionId, version: v, allocations: [{ expectedPaymentId, amount: kes(amount) }], idempotencyKey: key('c') }))

    const [stale] = await confirm(1000, version + 5)
    expect(isDefinedError(stale) && stale.code).toBe('STALE_STATE')
    const [overDue] = await confirm(1200)
    expect(overDue).toMatchObject({ code: 'ALLOCATION_REJECTED', data: { expectedPaymentId: e, due: '1000' } })

    const pending = await payment(1000, 'INV-8001', 'pending_verification')
    const pendingVersion = (await client('clerk').transactions.get({ id: pending })).version
    const [unverified] = await confirm(1000, pendingVersion, e, pending)
    expect(unverified).toMatchObject({ code: 'INVALID_STATE', data: { status: 'pending_verification' } })

    const [ok] = await confirm(1000)
    expect(ok).toBeNull()
    const [closed] = await confirm(100, version + 1)
    expect(closed).toMatchObject({ code: 'INVALID_STATE', data: { status: 'paid' } })
  })

  it('over the unallocated amount → 422 on REST', async () => {
    const e = await expected('INV-8101', 9000)
    const t = await payment(500, 'INV-8101')
    const { version } = await client('clerk').transactions.get({ id: t })
    const res = await rest(api, cookies.get('clerk'), 'POST', '/v1/matches', {
      transactionId: t,
      version,
      allocations: [{ expectedPaymentId: e, amount: kes(600) }],
      idempotencyKey: key('rest'),
    })
    expect(res.status).toBe(422)
  })

  it('a viewer may suggest but not confirm', async () => {
    const e = await expected('INV-8201', 100)
    const t = await payment(100, 'INV-8201')
    const [error] = await safe(
      client('viewer').matches.confirm({ transactionId: t, version: 1, allocations: [{ expectedPaymentId: e, amount: kes(100) }], idempotencyKey: key('v') }),
    )
    expect(error).toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('exceptions.resolve', () => {
  it('closes an open exception with a note, once; viewers cannot', async () => {
    const t = await payment(700, 'nothing')
    const id = await noMatchException(t)
    const [forbidden] = await safe(client('viewer').exceptions.resolve({ id, version: 1, resolution: 'dismissed', note: 'n/a', idempotencyKey: key('r') }))
    expect(forbidden).toMatchObject({ code: 'FORBIDDEN' })

    const done = await client('clerk').exceptions.resolve({ id, version: 1, resolution: 'dismissed', note: 'Test payment from our own phone.', idempotencyKey: key('r') })
    expect(done.result).toMatchObject({ status: 'dismissed', note: 'Test payment from our own phone.', version: 2 })
    const [again] = await safe(client('clerk').exceptions.resolve({ id, version: 2, resolution: 'resolved', note: 'again', idempotencyKey: key('r') }))
    expect(again).toMatchObject({ code: 'INVALID_STATE', data: { status: 'dismissed' } })
    expect((await client('clerk').exceptions.list({})).items.map((x) => x.id)).not.toContain(id)
  })
})
