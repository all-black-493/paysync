import { createTestDatabase, type TestDatabase } from '@paysync/test-utils'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestApi, type TestApi } from './harness.test.support.js'

describe('api health against a migrated database', () => {
  let db: TestDatabase
  let api: TestApi
  beforeAll(async () => {
    db = await createTestDatabase()
    api = await startTestApi(db)
  })
  afterAll(async () => {
    await api.close()
    await db.drop()
  })

  it('is healthy and ready', async () => {
    expect((await fetch(`${api.baseUrl}/healthz`)).status).toBe(200)
    const res = await fetch(`${api.baseUrl}/readyz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      status: 'ready',
      checks: [
        { name: 'database', ok: true },
        { name: 'migrations', ok: true },
      ],
    })
  })

  it('stops being ready while draining', async () => {
    api.health.startDraining()
    expect((await fetch(`${api.baseUrl}/readyz`)).status).toBe(503)
    expect((await fetch(`${api.baseUrl}/healthz`)).status).toBe(200)
  })

  it('404s unknown paths', async () => {
    expect((await fetch(`${api.baseUrl}/nothing`)).status).toBe(404)
    expect((await fetch(`${api.baseUrl}/api/v1/nothing`)).status).toBe(404)
  })
})

describe('api health against an unmigrated database', () => {
  let db: TestDatabase
  let api: TestApi
  beforeAll(async () => {
    db = await createTestDatabase({ from: 'empty' })
    api = await startTestApi(db)
  })
  afterAll(async () => {
    await api.close()
    await db.drop()
  })

  it('is alive but not ready', async () => {
    expect((await fetch(`${api.baseUrl}/healthz`)).status).toBe(200)
    const res = await fetch(`${api.baseUrl}/readyz`)
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ checks: [{ name: 'database', ok: true }, { name: 'migrations', ok: false }] })
  })
})
