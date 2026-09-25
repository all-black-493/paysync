import type { AddressInfo } from 'node:net'
import { loadMigrations } from '@paysync/db'
import { closeServer, createLogger, listen } from '@paysync/platform'
import { createTestDatabase, type TestDatabase } from '@paysync/test-utils'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApiServer, type ApiServer } from './server.js'

const logger = createLogger({ service: 'test', level: 'silent' })

async function startApi(db: TestDatabase): Promise<ApiServer & { url: (path: string) => string }> {
  const api = createApiServer({ pool: db.pool('app'), migrations: loadMigrations(), logger })
  await listen(api.server, 0, '127.0.0.1')
  const { port } = api.server.address() as AddressInfo
  return { ...api, url: (path) => `http://127.0.0.1:${port}${path}` }
}

describe('api health against a migrated database', () => {
  let db: TestDatabase
  let api: Awaited<ReturnType<typeof startApi>>
  beforeAll(async () => {
    db = await createTestDatabase()
    api = await startApi(db)
  })
  afterAll(async () => {
    await closeServer(api.server)
    await db.drop()
  })

  it('is healthy and ready', async () => {
    expect((await fetch(api.url('/healthz'))).status).toBe(200)
    const res = await fetch(api.url('/readyz'))
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
    expect((await fetch(api.url('/readyz'))).status).toBe(503)
    expect((await fetch(api.url('/healthz'))).status).toBe(200)
  })

  it('404s everything else', async () => {
    expect((await fetch(api.url('/api/anything'))).status).toBe(404)
  })
})

describe('api health against an unmigrated database', () => {
  let db: TestDatabase
  let api: Awaited<ReturnType<typeof startApi>>
  beforeAll(async () => {
    db = await createTestDatabase({ from: 'empty' })
    api = await startApi(db)
  })
  afterAll(async () => {
    await closeServer(api.server)
    await db.drop()
  })

  it('is alive but not ready', async () => {
    expect((await fetch(api.url('/healthz'))).status).toBe(200)
    const res = await fetch(api.url('/readyz'))
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ checks: [{ name: 'database', ok: true }, { name: 'migrations', ok: false }] })
  })
})
