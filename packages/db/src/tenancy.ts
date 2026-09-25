import { setTimeout as sleep } from 'node:timers/promises'
import { sql } from 'drizzle-orm'
import type { Db } from './client.js'

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

export interface WithOrgOptions {
  readonly isolation?: 'read committed' | 'serializable'
  /** Attempts on serialization failure or deadlock (serializable only). */
  readonly attempts?: number
}

const RETRYABLE = new Set(['40001', '40P01'])

/** Walks the cause chain; drizzle wraps driver errors. */
export function pgErrorCode(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if ('code' in current && typeof current.code === 'string') return current.code
    current = current.cause
  }
  return undefined
}

export function pgConstraint(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if ('constraint' in current && typeof current.constraint === 'string') return current.constraint
    current = current.cause
  }
  return undefined
}

/**
 * The only way to touch tenant tables: row-level security only returns rows
 * of `orgId`, and with no org set it returns none.
 */
export async function withOrg<T>(
  db: Db,
  orgId: string,
  fn: (tx: Tx) => Promise<T>,
  options: WithOrgOptions = {},
): Promise<T> {
  if (orgId === '') throw new Error('withOrg requires an organization id')
  const isolation = options.isolation ?? 'read committed'
  const attempts = isolation === 'serializable' ? (options.attempts ?? 3) : 1

  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction(
        async (tx) => {
          await tx.execute(sql`SELECT set_config('app.org_id', ${orgId}, true)`)
          return fn(tx)
        },
        { isolationLevel: isolation },
      )
    } catch (error) {
      const code = pgErrorCode(error)
      if (attempt >= attempts || code === undefined || !RETRYABLE.has(code)) throw error
      await sleep(10 * 2 ** attempt + Math.floor(Math.random() * 25))
    }
  }
}
