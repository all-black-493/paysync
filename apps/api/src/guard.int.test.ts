import { formatTimeline, replay } from '@paysync/audit'
import { createTestDatabase, type TestDatabase } from '@paysync/test-utils'
import { safe } from '@orpc/client'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { addMember, createOrg, createUser, key, rest, rpcClient, signIn, startTestApi, type TestApi, type TestUser } from './harness.test.support.js'

let database: TestDatabase
let api: TestApi
let admin: pg.Pool
let orgId: string
let shortcodeId: string
type Name = 'owner' | 'accountant' | 'clerk' | 'viewer' | 'admin2'
let users!: Record<Name, TestUser>
const cookies = new Map<Name, string>()
const client = (name: Name) => rpcClient(api, cookies.get(name))
const kes = (minor: number) => ({ minor: String(minor), currency: 'KES' as const })

beforeAll(async () => {
  database = await createTestDatabase()
  api = await startTestApi(database)
  admin = database.pool('admin')
  users = {
    owner: await createUser(api.auth, 'Olga'),
    accountant: await createUser(api.auth, 'Abel'),
    clerk: await createUser(api.auth, 'Cleo'),
    viewer: await createUser(api.auth, 'Vic'),
    admin2: await createUser(api.auth, 'Ada'),
  }
  orgId = await createOrg(api.auth, 'Acme', users.owner)
  await addMember(api.auth, orgId, users.accountant, 'accountant')
  await addMember(api.auth, orgId, users.clerk, 'clerk')
  await addMember(api.auth, orgId, users.viewer, 'viewer')
  await addMember(api.auth, orgId, users.admin2, 'admin')
  for (const [name, user] of Object.entries(users) as Array<[Name, TestUser]>) cookies.set(name, await signIn(api, user))
  // Approvers have TOTP (enrollment itself is Better Auth's flow, exercised in the web app).
  await admin.query(`UPDATE auth.user SET two_factor_enabled = true WHERE id = ANY($1)`, [[users.owner.id, users.accountant.id]])
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO core.shortcode (org_id, code, kind, environment, c2b_enabled, initiator_enabled) VALUES ($1, '600222', 'paybill', 'sandbox', true, true) RETURNING id`,
    [orgId],
  )
  shortcodeId = rows[0]?.id ?? ''
})

afterAll(async () => {
  await api.close()
  await database.drop()
})

let counter = 0
async function payment(amount: number, billRef = 'X'): Promise<{ id: string; version: number }> {
  const receipt = `RKLGRD${String(++counter).padStart(4, '0')}`
  const { rows } = await admin.query<{ id: string; version: number }>(
    `INSERT INTO core.mpesa_transaction (org_id, shortcode_id, receipt_number, amount, transacted_at, source, bill_ref_number, status, verified_at)
     VALUES ($1, $2, $3, $4, now(), 'c2b', $5, 'verified', now()) RETURNING id, version`,
    [orgId, shortcodeId, receipt, amount, billRef],
  )
  const row = rows[0]
  if (!row) throw new Error('no payment')
  return row
}

async function expected(reference: string, amountDue: number) {
  const created = await client('clerk').expected.create({ reference, amountDue: kes(amountDue), idempotencyKey: key('e') })
  return created.result
}

const ApprovalRequired = z.object({
  code: z.literal('APPROVAL_REQUIRED'),
  data: z.object({ pendingActionId: z.string(), summary: z.string(), approvalsRequired: z.number(), preview: z.unknown() }),
})

/** Runs a guarded call that must wait for approval and returns the APPROVAL_REQUIRED data. */
async function pendingFrom(call: Promise<unknown>) {
  const [error] = await safe(call)
  expect(error).toMatchObject({ code: 'APPROVAL_REQUIRED' })
  return ApprovalRequired.parse(error).data
}

async function pendingVersion(id: string): Promise<number> {
  return (await client('viewer').pendingActions.get({ id })).version
}

const decide = async (name: Name, id: string, decision: 'approve' | 'reject' = 'approve') =>
  safe(client(name).approvals.decide({ id, version: await pendingVersion(id), decision, idempotencyKey: key('d') }))

describe('requesting a destructive action', () => {
  it('dry run previews and changes nothing, not even the queue', async () => {
    const e = await expected('INV-G001', 1000)
    const preview = await client('clerk').expected.void({ id: e.id, version: e.version, reason: 'Duplicate invoice', idempotencyKey: key('v'), dryRun: true })
    expect(preview).toMatchObject({ dryRun: true, changed: true, result: { id: e.id, status: 'void' } })
    expect((await client('clerk').expected.get({ id: e.id })).status).toBe('open')
    expect((await client('viewer').pendingActions.list({})).items.map((p) => p.input)).not.toContainEqual(expect.objectContaining({ id: e.id }))
  })

  it('waits for approval with a summary and preview; the same key returns the same request', async () => {
    const e = await expected('INV-G002', 2500)
    const idempotencyKey = key('v')
    const input = { id: e.id, version: e.version, reason: 'Customer moved out', idempotencyKey }
    const first = await pendingFrom(client('clerk').expected.void(input))
    expect(first).toMatchObject({ approvalsRequired: 1, summary: expect.stringContaining('INV-G002') as unknown, preview: { id: e.id, status: 'void' } })
    expect((await pendingFrom(client('clerk').expected.void(input))).pendingActionId).toBe(first.pendingActionId)
    expect((await client('clerk').expected.get({ id: e.id })).status).toBe('open')
    expect(await client('viewer').pendingActions.get({ id: first.pendingActionId })).toMatchObject({
      procedure: 'expected.void',
      status: 'pending',
      requestedBy: { id: users.clerk.id, name: 'Cleo' },
      approvals: [],
    })
  })
})

describe('who may decide', () => {
  it('not the requester, not a clerk, not without two-factor, not with an old session, never over REST', async () => {
    const e = await expected('INV-G003', 500)
    const { pendingActionId } = await pendingFrom(client('accountant').expected.void({ id: e.id, version: e.version, reason: 'Mine', idempotencyKey: key('v') }))

    const [own] = await decide('accountant', pendingActionId)
    expect(own).toMatchObject({ code: 'FORBIDDEN', message: 'You cannot decide on your own request.' })
    const [clerk] = await decide('clerk', pendingActionId)
    expect(clerk).toMatchObject({ code: 'FORBIDDEN' })
    const [noTwoFactor] = await decide('admin2', pendingActionId)
    expect(noTwoFactor).toMatchObject({ code: 'STEP_UP_REQUIRED', data: { reason: 'two_factor_required' } })

    // (Signing in again is not possible here: with two-factor on, sign-in asks for a TOTP code.)
    await admin.query(`UPDATE auth.session SET created_at = now() - interval '1 hour' WHERE user_id = $1`, [users.owner.id])
    const [stale] = await decide('owner', pendingActionId)
    expect(stale).toMatchObject({ code: 'STEP_UP_REQUIRED', data: { reason: 'session_too_old' } })
    await admin.query(`UPDATE auth.session SET created_at = now() WHERE user_id = $1`, [users.owner.id])

    const viaRest = await rest(api, cookies.get('owner'), 'POST', `/v1/pending-actions/${pendingActionId}/decide`, {
      version: await pendingVersion(pendingActionId),
      decision: 'approve',
      idempotencyKey: key('d'),
    })
    expect(viaRest.status).toBe(403)
    expect((await client('viewer').pendingActions.get({ id: pendingActionId })).status).toBe('pending')
  })

  it('the database refuses a requester approving their own action, whatever the code does', async () => {
    const e = await expected('INV-G004', 700)
    const { pendingActionId } = await pendingFrom(client('clerk').expected.void({ id: e.id, version: e.version, reason: 'x x x', idempotencyKey: key('v') }))
    await expect(
      admin.query(`INSERT INTO agent.approval (org_id, pending_action_id, approver_user_id, decision) VALUES ($1, $2, $3, 'approve')`, [orgId, pendingActionId, users.clerk.id]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'agent_approval_not_requester' })
  })
})

describe('deciding', () => {
  it('approve: runs once as the requester; the ledger reverses the invoice; the original key returns the result', async () => {
    const e = await expected('INV-G005', 1200)
    const idempotencyKey = key('v')
    const input = { id: e.id, version: e.version, reason: 'Issued in error', idempotencyKey }
    const { pendingActionId } = await pendingFrom(client('clerk').expected.void(input))

    const [error, decided] = await decide('accountant', pendingActionId)
    expect(error).toBeNull()
    expect(decided).toMatchObject({ status: 'executed', approvals: [{ approverId: users.accountant.id, decision: 'approve' }], result: { status: 'void' } })
    expect((await client('clerk').expected.get({ id: e.id })).status).toBe('void')
    expect(await client('clerk').expected.void(input)).toMatchObject({ dryRun: false, changed: true, result: { id: e.id, status: 'void' } })

    const { rows } = await admin.query<{ kind: string; amount: string }>(
      `SELECT j.kind, en.amount::text FROM ledger.journal j JOIN ledger.entry en ON en.journal_id = j.id JOIN ledger.account a ON a.id = en.account_id
       WHERE a.code = 'receivables' AND j.idempotency_key LIKE $1 ORDER BY j.created_at`,
      [`invoice:${e.id}%`],
    )
    expect(rows).toEqual([
      { kind: 'invoice', amount: '1200' },
      { kind: 'invoice_void', amount: '-1200' },
    ])
    const { rows: audit } = await admin.query<{ decision: string; user_id: string }>(
      `SELECT decision, user_id FROM audit.event WHERE action = 'expected.void' AND details->>'pendingActionId' = $1 ORDER BY occurred_at`,
      [pendingActionId],
    )
    expect(audit).toEqual([
      { decision: 'require_approval', user_id: users.clerk.id },
      { decision: 'approved', user_id: users.clerk.id },
    ])
    const timeline = formatTimeline(await replay(api.db, orgId, { userId: users.clerk.id }))
    expect(timeline).toMatch(/expected\.void \[require_approval\] → pending — destructive: always needs approval/)
    expect(timeline).toMatch(/expected\.void \[approved\] → changed/)
  })

  it('reject: nothing changes, and the key cannot be reused', async () => {
    const e = await expected('INV-G006', 900)
    const input = { id: e.id, version: e.version, reason: 'Wrong one', idempotencyKey: key('v') }
    const { pendingActionId } = await pendingFrom(client('clerk').expected.void(input))
    const [, decided] = await decide('accountant', pendingActionId, 'reject')
    expect(decided?.status).toBe('rejected')
    expect((await client('clerk').expected.get({ id: e.id })).status).toBe('open')
    const [again] = await safe(client('clerk').expected.void(input))
    expect(again).toMatchObject({ code: 'INVALID_STATE', data: { status: 'request_rejected' } })
  })

  it('if the target changed after the request, approval fails with STALE_STATE and nothing runs', async () => {
    const e = await expected('INV-G007', 800)
    const { pendingActionId } = await pendingFrom(client('clerk').expected.void({ id: e.id, version: e.version, reason: 'Old', idempotencyKey: key('v') }))
    await client('clerk').expected.update({ id: e.id, version: e.version, description: 'edited meanwhile', idempotencyKey: key('u') })
    const [error] = await decide('accountant', pendingActionId)
    expect(error).toMatchObject({ code: 'STALE_STATE' })
    expect((await client('viewer').pendingActions.get({ id: pendingActionId })).status).toBe('failed')
    expect((await client('clerk').expected.get({ id: e.id })).status).toBe('open')
  })

  it('expired requests cannot be decided', async () => {
    const e = await expected('INV-G008', 300)
    const { pendingActionId } = await pendingFrom(client('clerk').expected.void({ id: e.id, version: e.version, reason: 'Late', idempotencyKey: key('v') }))
    await admin.query(`UPDATE agent.pending_action SET expires_at = now() - interval '1 minute', version = version + 1 WHERE id = $1`, [pendingActionId])
    const [error] = await safe(client('accountant').approvals.decide({ id: pendingActionId, version: 3, decision: 'approve', idempotencyKey: key('d') }))
    expect(error).toMatchObject({ code: 'INVALID_STATE', data: { status: 'expired' } })
  })
})

describe('money: reversal', () => {
  it('needs two different approvers, then queues the Daraja call once', async () => {
    const t = await payment(4000)
    const { pendingActionId, approvalsRequired } = await pendingFrom(
      client('accountant').reversals.request({ transactionId: t.id, version: t.version, reason: 'Paid the wrong business', idempotencyKey: key('r') }),
    )
    expect(approvalsRequired).toBe(2)
    const [, first] = await decide('owner', pendingActionId)
    expect(first).toMatchObject({ status: 'pending', approvals: [{ approverId: users.owner.id }] })
    // The same approver again does not count twice.
    const [, repeat] = await safe(client('owner').approvals.decide({ id: pendingActionId, version: 1, decision: 'approve', idempotencyKey: key('d') }))
    expect(repeat?.approvals).toHaveLength(1)

    await admin.query(`UPDATE auth.user SET two_factor_enabled = true WHERE id = $1`, [users.admin2.id])
    const [, second] = await decide('admin2', pendingActionId)
    expect(second).toMatchObject({ status: 'executed', result: { transactionId: t.id, status: 'queued', amount: kes(4000) } })
    const { rows } = await admin.query<{ kind: string; status: string; n: string }>(
      `SELECT r.kind, r.status, (SELECT count(*) FROM jobs.jobs j WHERE j.task_identifier = 'execute_reversal')::text AS n
       FROM ingest.daraja_request r WHERE r.transaction_id = $1`,
      [t.id],
    )
    expect(rows).toEqual([{ kind: 'reversal', status: 'initiated', n: '1' }])
    expect((await client('viewer').transactions.get({ id: t.id })).status).toBe('verified')
    await admin.query(`UPDATE auth.user SET two_factor_enabled = false WHERE id = $1`, [users.admin2.id])
  })

  it('clerks cannot even request a reversal', async () => {
    const t = await payment(100)
    const [error] = await safe(client('clerk').reversals.request({ transactionId: t.id, version: t.version, reason: 'nope nope', idempotencyKey: key('r') }))
    expect(error).toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('unmatch', () => {
  it('after approval, allocations stop counting, the invoice reopens and the ledger entry is reversed', async () => {
    const e = await expected('INV-G010', 1500)
    const t = await payment(1500, 'INV-G010')
    const matched = await client('clerk').matches.confirm({ transactionId: t.id, version: t.version, allocations: [{ expectedPaymentId: e.id, amount: kes(1500) }], idempotencyKey: key('m') })
    const { pendingActionId } = await pendingFrom(client('clerk').matches.unmatch({ id: matched.result.id, reason: 'Belongs to another tenant', idempotencyKey: key('u') }))
    const [, decided] = await decide('accountant', pendingActionId)
    expect(decided).toMatchObject({ status: 'executed', result: { id: matched.result.id, status: 'unmatched' } })
    expect(await client('clerk').expected.get({ id: e.id })).toMatchObject({ status: 'open', amountPaid: kes(0) })
    expect(await client('clerk').transactions.get({ id: t.id })).toMatchObject({ allocated: kes(0), unallocated: kes(1500) })
    const { rows } = await admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM ledger.journal WHERE idempotency_key = $1`, [`unallocation:${matched.result.id}`])
    expect(rows[0]?.n).toBe('1')
  })
})

describe('write-offs: cap and budget', () => {
  it('above the cap is blocked outright; within it waits for approval, then counts against the payment', async () => {
    const t = await payment(90_000)
    const [blocked] = await safe(
      client('clerk').transactions.writeOffVariance({ transactionId: t.id, version: t.version, amount: kes(60_000), reason: 'Too big', idempotencyKey: key('w') }),
    )
    expect(blocked).toMatchObject({ code: 'BLOCKED', data: { reason: expect.stringContaining('cap') as unknown } })

    const { pendingActionId } = await pendingFrom(
      client('clerk').transactions.writeOffVariance({ transactionId: t.id, version: t.version, amount: kes(300), reason: 'Rounding by payer', idempotencyKey: key('w') }),
    )
    await decide('accountant', pendingActionId)
    expect(await client('clerk').transactions.get({ id: t.id })).toMatchObject({ writtenOff: kes(300), unallocated: kes(89_700) })
  })

  it('the daily budget refuses what would exceed it', async () => {
    const t = await payment(200_000)
    await admin.query(
      `INSERT INTO core.variance_write_off (org_id, transaction_id, amount, reason, created_by) VALUES ($1, $2, 180000, 'earlier today', 'test')`,
      [orgId, t.id],
    )
    const other = await payment(10_000)
    const [error] = await safe(
      client('clerk').transactions.writeOffVariance({ transactionId: other.id, version: other.version, amount: kes(30_000), reason: 'Over budget', idempotencyKey: key('w') }),
    )
    expect(error).toMatchObject({ code: 'BUDGET_EXCEEDED', data: { budget: 'writeoffs' } })
  })
})

describe('rate limit', () => {
  it('too many writes in a minute are refused before anything else', async () => {
    await admin.query(
      `INSERT INTO audit.event (org_id, surface, user_id, action, outcome) SELECT $1, 'web', $2, 'test', 'changed' FROM generate_series(1, 60)`,
      [orgId, users.viewer.id],
    )
    await admin.query(`UPDATE auth.member SET role = 'clerk' WHERE user_id = $1`, [users.viewer.id])
    const e = await expected('INV-G011', 100)
    const [error] = await safe(client('viewer').expected.void({ id: e.id, version: e.version, reason: 'Too fast', idempotencyKey: key('v') }))
    expect(error).toMatchObject({ code: 'RATE_LIMITED' })
    await admin.query(`UPDATE auth.member SET role = 'viewer' WHERE user_id = $1`, [users.viewer.id])
  })
})
