import { createLogger, databaseConnectionParams } from '@paysync/platform'
import { createTestDatabase, type TestDatabase } from '@paysync/test-utils'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadMigrations } from './migrations.js'
import { MigrationError, checkMigrations, runMigrations } from './runner.js'

const logger = createLogger({ service: 'test', level: 'silent' })
const migrations = loadMigrations()

async function asMigrator<T>(db: TestDatabase, run: (client: pg.Client) => Promise<T>): Promise<T> {
  const { url, password } = db.connection('migrator')
  const client = new pg.Client(databaseConnectionParams(url, password))
  await client.connect()
  try {
    return await run(client)
  } finally {
    await client.end()
  }
}

describe('migrated template', () => {
  let db: TestDatabase
  beforeAll(async () => {
    db = await createTestDatabase()
  })
  afterAll(async () => {
    await db.drop()
  })

  it('has every committed migration applied', async () => {
    await expect(checkMigrations(db.pool('app'), migrations)).resolves.toEqual({ ok: true, missing: [] })
  })

  it('re-running migrations is a no-op', async () => {
    const result = await asMigrator(db, (c) => runMigrations(c, migrations, logger))
    expect(result.applied).toEqual([])
    expect(result.alreadyApplied).toBe(migrations.length)
  })

  it('refuses to run when an applied migration was edited', async () => {
    const [first] = migrations
    if (!first) throw new Error('no migrations')
    const edited = { ...first, checksum: '0'.repeat(64) }
    await expect(asMigrator(db, (c) => runMigrations(c, [edited], logger))).rejects.toThrow(MigrationError)
  })

  it('objects are owned by paysync_owner, not by the login role', async () => {
    const { rows } = await db.pool('admin').query<{ nspname: string; owner: string }>(
      `SELECT nspname, pg_get_userbyid(nspowner) AS owner FROM pg_namespace
       WHERE nspname IN ('meta', 'ingest', 'core', 'ledger', 'agent', 'audit', 'stream')`,
    )
    expect(rows).toHaveLength(7)
    for (const row of rows) expect(row.owner).toBe('paysync_owner')
  })
})

describe('paysync_app role (AGENTS.md §6B.2, §6B.4)', () => {
  let db: TestDatabase
  beforeAll(async () => {
    db = await createTestDatabase()
  })
  afterAll(async () => {
    await db.drop()
  })

  it('is not superuser and cannot bypass RLS, create roles or databases', async () => {
    const { rows } = await db.pool('app').query<Record<string, boolean>>(
      `SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user`,
    )
    expect(rows).toEqual([{ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false }])
  })

  it('cannot run DDL in public or in app schemas', async () => {
    const app = db.pool('app')
    await expect(app.query('CREATE TABLE public.nope (id int)')).rejects.toMatchObject({ code: '42501' })
    await expect(app.query('CREATE TABLE core.nope (id int)')).rejects.toMatchObject({ code: '42501' })
  })

  it('cannot become the owner role', async () => {
    await expect(db.pool('app').query('SET ROLE paysync_owner')).rejects.toMatchObject({ code: '42501' })
  })

  it('has the per-role safety timeouts', async () => {
    const app = db.pool('app')
    const show = async (name: string) => (await app.query<Record<string, string>>(`SHOW ${name}`)).rows[0]?.[name]
    expect(await show('statement_timeout')).toBe('15s')
    expect(await show('lock_timeout')).toBe('5s')
    expect(await show('idle_in_transaction_session_timeout')).toBe('30s')
  })
})

describe('empty database', () => {
  let db: TestDatabase
  beforeAll(async () => {
    db = await createTestDatabase({ from: 'empty' })
  })
  afterAll(async () => {
    await db.drop()
  })

  it('migrates from scratch, then reports ready', async () => {
    const result = await asMigrator(db, (c) => runMigrations(c, migrations, logger))
    expect(result.applied).toEqual(migrations.map((m) => m.id))
    await expect(checkMigrations(db.pool('app'), migrations)).resolves.toMatchObject({ ok: true })
  })
})
