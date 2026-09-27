import { setTimeout as sleep } from 'node:timers/promises'
import type { Sealer } from '@paysync/platform'
import type pg from 'pg'

export interface CachedToken {
  readonly token: string
  readonly expiresAt: Date
}

export interface DarajaTokenStore {
  read(credentialId: string): Promise<CachedToken | null>
  write(credentialId: string, token: CachedToken): Promise<void>
  withLock<T>(credentialId: string, fn: () => Promise<T>): Promise<T>
}

/**
 * Postgres-backed token cache shared by every api/worker replica. The lock is
 * a session advisory lock on a dedicated connection with no open transaction,
 * because the refresh calls Daraja while holding it.
 */
export function createDarajaTokenStore(pool: pg.Pool, sealer: Sealer, lockTimeoutMs = 20_000): DarajaTokenStore {
  return {
    async read(credentialId) {
      const { rows } = await pool.query<{ ciphertext: Buffer; expires_at: Date }>(
        'SELECT ciphertext, expires_at FROM ingest.daraja_token WHERE credential_id = $1',
        [credentialId],
      )
      const row = rows[0]
      return row ? { token: sealer.open(row.ciphertext), expiresAt: row.expires_at } : null
    },
    async write(credentialId, token) {
      await pool.query(
        `INSERT INTO ingest.daraja_token (credential_id, ciphertext, expires_at, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (credential_id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, expires_at = EXCLUDED.expires_at, updated_at = now()`,
        [credentialId, sealer.seal(token.token), token.expiresAt],
      )
    },
    async withLock(credentialId, fn) {
      const client = await pool.connect()
      const key = `daraja-token:${credentialId}`
      try {
        const deadline = Date.now() + lockTimeoutMs
        for (;;) {
          const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [key])
          if (rows[0]?.ok) break
          if (Date.now() > deadline) throw new Error('timed out waiting for the Daraja token lock')
          await sleep(100 + Math.floor(Math.random() * 100))
        }
        try {
          return await fn()
        } finally {
          await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key])
        }
      } finally {
        client.release()
      }
    },
  }
}
