import type { Logger } from '@paysync/platform'
import type pg from 'pg'
import type { Migration } from './migrations.js'
import { ROLES } from './roles.js'

const MIGRATION_LOCK_KEY = '7220115001'

export class MigrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'MigrationError'
  }
}

type Queryable = Pick<pg.ClientBase, 'query'>

const BOOTSTRAP_SQL = `
  CREATE SCHEMA IF NOT EXISTS meta;
  CREATE TABLE IF NOT EXISTS meta.schema_migration (
    id          text        PRIMARY KEY,
    checksum    text        NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
    applied_at  timestamptz NOT NULL DEFAULT now()
  );
  GRANT USAGE ON SCHEMA meta TO ${ROLES.app}, ${ROLES.readonly};
  GRANT SELECT ON meta.schema_migration TO ${ROLES.app}, ${ROLES.readonly};
`

export interface MigrationRunResult {
  readonly applied: readonly string[]
  readonly alreadyApplied: number
}

export async function runMigrations(
  client: pg.ClientBase,
  migrations: readonly Migration[],
  logger: Logger,
): Promise<MigrationRunResult> {
  await client.query(`SET ROLE ${ROLES.owner}`)
  await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY])
  try {
    await client.query(BOOTSTRAP_SQL)
    const { rows } = await client.query<{ id: string; checksum: string }>(
      'SELECT id, checksum FROM meta.schema_migration',
    )
    const recorded = new Map(rows.map((r) => [r.id, r.checksum]))

    const applied: string[] = []
    for (const migration of migrations) {
      const existing = recorded.get(migration.id)
      if (existing !== undefined) {
        if (existing !== migration.checksum) {
          throw new MigrationError(
            `migration ${migration.id} was changed after it was applied (checksum mismatch). ` +
              'Migrations are forward-only: add a new migration instead.',
          )
        }
        continue
      }
      logger.info({ migration: migration.id, transactional: migration.transactional }, 'applying migration')
      await applyOne(client, migration)
      applied.push(migration.id)
    }
    return { applied, alreadyApplied: recorded.size }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
  }
}

async function applyOne(client: pg.ClientBase, migration: Migration): Promise<void> {
  const record = (q: Queryable) =>
    q.query('INSERT INTO meta.schema_migration (id, checksum) VALUES ($1, $2)', [migration.id, migration.checksum])

  if (!migration.transactional) {
    try {
      await client.query(migration.sql)
    } catch (error) {
      throw new MigrationError(`migration ${migration.id} failed (non-transactional; check state)`, { cause: error })
    }
    await record(client)
    return
  }

  await client.query('BEGIN')
  try {
    await client.query(migration.sql)
    await record(client)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw new MigrationError(`migration ${migration.id} failed and was rolled back`, { cause: error })
  }
}

export interface MigrationStatus {
  readonly ok: boolean
  readonly missing: readonly string[]
}

// The DB may be ahead of the app during expand/contract deploys, so only missing ids matter.
export async function checkMigrations(db: Queryable, expected: readonly Migration[]): Promise<MigrationStatus> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM meta.schema_migration WHERE id = ANY($1::text[])`,
    [expected.map((m) => m.id)],
  )
  const present = new Set(rows.map((r) => r.id))
  const missing = expected.filter((m) => !present.has(m.id)).map((m) => m.id)
  return { ok: missing.length === 0, missing }
}
