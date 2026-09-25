import { randomBytes } from 'node:crypto'
import { databaseConnectionParams, databaseUrlSchema, loadConfig } from '@paysync/platform'
import pg from 'pg'
import { z } from 'zod'

const testEnvSchema = z.object({
  TEST_ADMIN_DATABASE_URL: databaseUrlSchema,
  TEST_ADMIN_PASSWORD: z.string().min(1),
  TEST_APP_PASSWORD: z.string().min(1),
  TEST_MIGRATOR_PASSWORD: z.string().min(1),
  TEST_TEMPLATE_DATABASE: z.string().regex(/^[a-z_][a-z0-9_]*$/),
})

type TestEnv = z.output<typeof testEnvSchema>

let cachedEnv: TestEnv | undefined
function testEnv(): TestEnv {
  cachedEnv ??= loadConfig(testEnvSchema, {
    secrets: ['TEST_ADMIN_PASSWORD', 'TEST_APP_PASSWORD', 'TEST_MIGRATOR_PASSWORD'],
  })
  return cachedEnv
}

export type TestRole = 'admin' | 'app' | 'migrator'

const LOGIN_ROLES = ['paysync_migrator', 'paysync_app', 'paysync_readonly'] as const

export interface Connection {
  readonly url: string
  readonly password: string
}

export interface TestDatabase {
  readonly name: string
  connection(role: TestRole): Connection
  pool(role: TestRole): pg.Pool
  drop(): Promise<void>
}

function connectionFor(env: TestEnv, database: string, role: TestRole): Connection {
  const url = new URL(env.TEST_ADMIN_DATABASE_URL)
  url.pathname = `/${database}`
  switch (role) {
    case 'admin':
      return { url: url.toString(), password: env.TEST_ADMIN_PASSWORD }
    case 'app':
      url.username = 'paysync_app'
      return { url: url.toString(), password: env.TEST_APP_PASSWORD }
    case 'migrator':
      url.username = 'paysync_migrator'
      return { url: url.toString(), password: env.TEST_MIGRATOR_PASSWORD }
  }
}

async function withAdmin<T>(env: TestEnv, run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client(databaseConnectionParams(env.TEST_ADMIN_DATABASE_URL, env.TEST_ADMIN_PASSWORD))
  await client.connect()
  try {
    return await run(client)
  } finally {
    await client.end()
  }
}

export interface CreateTestDatabaseOptions {
  readonly from?: 'migrated' | 'empty'
}

export async function createTestDatabase(options: CreateTestDatabaseOptions = {}): Promise<TestDatabase> {
  const env = testEnv()
  const name = `test_${randomBytes(6).toString('hex')}`
  const template = options.from === 'empty' ? 'template0' : env.TEST_TEMPLATE_DATABASE

  await withAdmin(env, async (admin) => {
    const quoted = admin.escapeIdentifier(name)
    await admin.query(`CREATE DATABASE ${quoted} TEMPLATE ${admin.escapeIdentifier(template)} OWNER paysync_owner`)
    // Database-level ACLs are not copied from the template.
    await admin.query(`REVOKE ALL ON DATABASE ${quoted} FROM PUBLIC`)
    await admin.query(`GRANT CONNECT ON DATABASE ${quoted} TO ${LOGIN_ROLES.join(', ')}`)
  })

  const pools: pg.Pool[] = []
  return {
    name,
    connection: (role) => connectionFor(env, name, role),
    pool(role) {
      const { url, password } = connectionFor(env, name, role)
      const pool = new pg.Pool({ ...databaseConnectionParams(url, password), max: 4 })
      pools.push(pool)
      return pool
    },
    async drop() {
      await Promise.all(pools.splice(0).map((p) => p.end()))
      await withAdmin(env, (admin) => admin.query(`DROP DATABASE ${admin.escapeIdentifier(name)} WITH (FORCE)`))
    },
  }
}

/** Inserts an organization as the superuser (bypasses row-level security). Returns its id. */
export async function createOrganization(db: TestDatabase, name: string): Promise<string> {
  const id = `org_${randomBytes(8).toString('hex')}`
  await db
    .pool('admin')
    .query('INSERT INTO auth.organization (id, name, slug, created_at) VALUES ($1, $2, $3, now())', [
      id,
      name,
      `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${id.slice(-6)}`,
    ])
  return id
}

/** Runs `fn` in a transaction scoped to `orgId`, the way withOrg does. */
export async function asOrg<T>(pool: pg.Pool, orgId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgId])
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
