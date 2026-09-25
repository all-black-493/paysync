import type { Logger } from '@paysync/platform'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import type pg from 'pg'
import { MIGRATIONS_DIR, MIGRATIONS_SCHEMA, MIGRATIONS_TABLE, loadMigrations, type Migration } from './migrations.js'
import { ROLES } from './roles.js'

const MIGRATION_LOCK_KEY = '7220115001'
const TABLE = `${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`

export class MigrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'MigrationError'
  }
}

type Queryable = Pick<pg.ClientBase, 'query'>

export interface AppliedMigration {
  readonly hash: string
  readonly createdAt: number
}

/**
 * drizzle's migrator neither detects edited migrations nor applies a migration
 * older than the newest applied one (it skips it silently), so both are refused here.
 */
export function verifyHistory(migrations: readonly Migration[], applied: readonly AppliedMigration[]): void {
  const lastKnown = migrations.at(-1)?.createdAt ?? -Infinity
  const lastApplied = Math.max(-Infinity, ...applied.map((a) => a.createdAt))
  const byCreatedAt = new Map(migrations.map((m) => [m.createdAt, m]))
  const appliedHashes = new Set(applied.map((a) => a.hash))

  for (const row of applied) {
    const known = byCreatedAt.get(row.createdAt)
    if (known && known.hash !== row.hash) {
      throw new MigrationError(`migration ${known.tag} was changed after it was applied; add a new migration instead`)
    }
    if (!known && row.createdAt <= lastKnown) {
      throw new MigrationError(`database has a migration (created_at ${row.createdAt}) that this build does not have`)
    }
  }
  for (const m of migrations) {
    if (m.createdAt <= lastApplied && !appliedHashes.has(m.hash)) {
      throw new MigrationError(`migration ${m.tag} is older than the newest applied one and would be skipped; regenerate it`)
    }
  }
}

async function readApplied(db: Queryable): Promise<AppliedMigration[]> {
  const { rows: exists } = await db.query<{ ok: boolean }>('SELECT to_regclass($1) IS NOT NULL AS ok', [TABLE])
  if (!exists[0]?.ok) return []
  const { rows } = await db.query<{ hash: string; created_at: string }>(`SELECT hash, created_at FROM ${TABLE}`)
  return rows.map((r) => ({ hash: r.hash, createdAt: Number(r.created_at) }))
}

export interface MigrationRunResult {
  readonly applied: readonly string[]
  readonly alreadyApplied: number
}

/** `client` must be a dedicated connection as paysync_migrator. */
export async function runMigrations(
  client: pg.Client,
  logger: Logger,
  dir: string = MIGRATIONS_DIR,
): Promise<MigrationRunResult> {
  const migrations = loadMigrations(dir)
  await client.query(`SET ROLE ${ROLES.owner}`)
  await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY])
  try {
    const before = await readApplied(client)
    verifyHistory(migrations, before)
    const beforeHashes = new Set(before.map((a) => a.hash))
    const pending = migrations.filter((m) => !beforeHashes.has(m.hash)).map((m) => m.tag)
    if (pending.length > 0) logger.info({ pending }, 'applying migrations')

    try {
      await migrate(drizzle({ client }), {
        migrationsFolder: dir,
        migrationsSchema: MIGRATIONS_SCHEMA,
        migrationsTable: MIGRATIONS_TABLE,
      })
    } catch (error) {
      throw new MigrationError('migrations failed and were rolled back', { cause: error })
    }
    await client.query(`
      GRANT USAGE ON SCHEMA ${MIGRATIONS_SCHEMA} TO ${ROLES.app}, ${ROLES.readonly};
      GRANT SELECT ON ${TABLE} TO ${ROLES.app}, ${ROLES.readonly};
    `)
    return { applied: pending, alreadyApplied: before.length }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
  }
}

export interface MigrationStatus {
  readonly ok: boolean
  readonly missing: readonly string[]
}

// The DB may be ahead of the app during expand/contract deploys, so only missing ones matter.
export async function checkMigrations(db: Queryable, expected: readonly Migration[]): Promise<MigrationStatus> {
  const applied = new Set((await readApplied(db)).map((a) => a.hash))
  const missing = expected.filter((m) => !applied.has(m.hash)).map((m) => m.tag)
  return { ok: missing.length === 0, missing }
}
