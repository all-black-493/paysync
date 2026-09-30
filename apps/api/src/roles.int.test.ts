import { createTestDatabase, type TestDatabase } from '@paysync/test-utils'
import { safe } from '@orpc/client'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { addMember, authPost, createOrg, createUser, key, rpcClient, signIn, startTestApi, type TestApi, type TestUser } from './harness.test.support.js'

let database: TestDatabase
let api: TestApi
let admin: pg.Pool
let orgId: string
type Name = 'owner' | 'admin' | 'clerk' | 'collector' | 'checker'
let users!: Record<Name, TestUser>
const cookies = new Map<Name, string>()
const cookie = (name: Name) => cookies.get(name) ?? ''
const client = (name: Name) => rpcClient(api, cookies.get(name))

async function memberId(user: TestUser): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(`SELECT id FROM auth.member WHERE organization_id = $1 AND user_id = $2`, [orgId, user.id])
  return rows[0]?.id ?? ''
}

async function auditActions(): Promise<Array<{ action: string; outcome: string }>> {
  const { rows } = await admin.query<{ action: string; outcome: string }>(
    `SELECT action, outcome FROM audit.event WHERE org_id = $1 AND action LIKE 'team.%' ORDER BY occurred_at`,
    [orgId],
  )
  return rows
}

beforeAll(async () => {
  database = await createTestDatabase()
  api = await startTestApi(database)
  admin = database.pool('admin')
  users = {
    owner: await createUser(api.auth, 'Olga'),
    admin: await createUser(api.auth, 'Ada'),
    clerk: await createUser(api.auth, 'Cleo'),
    collector: await createUser(api.auth, 'Cole'),
    checker: await createUser(api.auth, 'Chad'),
  }
  orgId = await createOrg(api.auth, 'Acme', users.owner)
  await addMember(api.auth, orgId, users.admin, 'admin')
  await addMember(api.auth, orgId, users.clerk, 'clerk')
  await addMember(api.auth, orgId, users.collector, 'viewer')
  await addMember(api.auth, orgId, users.checker, 'viewer')
  for (const [name, user] of Object.entries(users) as Array<[Name, TestUser]>) cookies.set(name, await signIn(api, user))
})

afterAll(async () => {
  await api.close()
  await database.drop()
})

describe('custom roles', () => {
  it('an owner creates a role and a member holding it gets exactly those permissions', async () => {
    const created = await authPost(api, cookie('owner'), '/organization/create-role', {
      role: 'Rent collector',
      permission: { transaction: ['read'], exception: ['read', 'annotate'] },
    })
    expect(created.status).toBe(200)
    const changed = await authPost(api, cookie('admin'), '/organization/update-member-role', { memberId: await memberId(users.collector), role: 'rent collector' })
    expect(changed.status, JSON.stringify(changed.body)).toBe(200)

    const me = await client('collector').me.get()
    // Better Auth stores role names in lower case.
    expect(me.role).toBe('rent collector')
    expect(me.permissions.exception).toMatchObject({ read: true, annotate: true, resolve: false })
    expect(me.permissions.approval.approve).toBe(false)
    expect(me.permissions.expectedPayment.read).toBe(false)
    expect((await client('collector').exceptions.list({})).items).toEqual([])
    const denied = await safe(client('collector').expected.list({}))
    expect(denied.error).toMatchObject({ code: 'FORBIDDEN' })
  })

  it('changing a role’s permissions applies on the next request', async () => {
    const updated = await authPost(api, cookie('owner'), '/organization/update-role', {
      roleName: 'rent collector',
      data: { permission: { transaction: ['read'], exception: ['read', 'annotate'], expectedPayment: ['read'] } },
    })
    expect(updated.status, JSON.stringify(updated.body)).toBe(200)
    expect((await client('collector').me.get()).permissions.expectedPayment.read).toBe(true)
  })

  it('custom roles never manage the team, roles or keys, and are never renamed', async () => {
    for (const permission of [{ apiKey: ['create'] }, { member: ['update'] }, { ac: ['create'] }, { invitation: ['create'] }]) {
      const res = await authPost(api, cookie('owner'), '/organization/create-role', { role: key('Sneaky').replace(/[^a-z0-9-]/gi, ''), permission })
      expect(res.status, JSON.stringify(permission)).toBe(400)
    }
    const rename = await authPost(api, cookie('owner'), '/organization/update-role', { roleName: 'rent collector', data: { roleName: 'Collector' } })
    expect(rename.status).toBe(400)
    for (const role of ['owner', 'Admin', 'a,b']) {
      expect((await authPost(api, cookie('owner'), '/organization/create-role', { role, permission: { report: ['read'] } })).status, role).toBe(400)
    }
  })

  it('a clerk cannot create roles; nobody grants what they lack or changes their own role', async () => {
    expect((await authPost(api, cookie('clerk'), '/organization/create-role', { role: 'Helper', permission: { report: ['read'] } })).status).toBe(403)
    const self = await authPost(api, cookie('admin'), '/organization/update-member-role', { memberId: await memberId(users.admin), role: 'viewer' })
    expect(self.status).toBe(403)
  })

  it('approving through a custom role still needs two-factor, and never your own request', async () => {
    expect(
      (await authPost(api, cookie('owner'), '/organization/create-role', { role: 'Checker', permission: { pendingAction: ['read'], approval: ['approve'] } })).status,
    ).toBe(200)
    expect((await authPost(api, cookie('owner'), '/organization/update-member-role', { memberId: await memberId(users.checker), role: 'checker' })).status).toBe(200)

    const expected = await client('clerk').expected.create({ reference: key('ROLE'), amountDue: { minor: '10000', currency: 'KES' }, idempotencyKey: key('exp') })
    const request = await safe(client('clerk').expected.void({ id: expected.result.id, version: expected.result.version, reason: 'duplicate entry', idempotencyKey: key('void') }))
    expect(request.error).toMatchObject({ code: 'APPROVAL_REQUIRED' })
    const { pendingActionId } = z.object({ data: z.object({ pendingActionId: z.string() }) }).parse(request.error).data
    const pending = await client('checker').pendingActions.get({ id: pendingActionId })

    const noTotp = await safe(client('checker').approvals.decide({ id: pendingActionId, version: pending.version, decision: 'approve', idempotencyKey: key('decide') }))
    expect(noTotp.error).toMatchObject({ code: 'STEP_UP_REQUIRED', data: { reason: 'two_factor_required' } })
  })

  it('a role still held cannot be deleted; once nobody holds it, it can', async () => {
    const held = await authPost(api, cookie('owner'), '/organization/delete-role', { roleName: 'rent collector' })
    expect(held.body).toMatchObject({ code: 'ROLE_IS_ASSIGNED_TO_MEMBERS' })
    expect((await authPost(api, cookie('owner'), '/organization/update-member-role', { memberId: await memberId(users.collector), role: 'viewer' })).status).toBe(200)
    expect((await authPost(api, cookie('owner'), '/organization/delete-role', { roleName: 'rent collector' })).status).toBe(200)
    expect((await client('collector').me.get()).permissions.exception.annotate).toBe(false)
  })

  it('every change is in the audit log', async () => {
    const actions = (await auditActions()).map((a) => `${a.action}:${a.outcome}`)
    expect(actions).toEqual(
      expect.arrayContaining(['team.create-role:changed', 'team.update-member-role:changed', 'team.update-role:changed', 'team.delete-role:changed']),
    )
  })
})
