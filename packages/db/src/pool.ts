import { databaseConnectionParams, type Logger } from '@paysync/platform'
import pg from 'pg'

export type Pool = pg.Pool
export type PoolClient = pg.PoolClient

export interface PoolOptions {
  readonly url: string
  readonly password: string
  readonly max: number
  readonly applicationName: string
  readonly logger: Logger
}

export function createPool(options: PoolOptions): Pool {
  const pool = new pg.Pool({
    ...databaseConnectionParams(options.url, options.password),
    max: options.max,
    application_name: options.applicationName,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  })
  pool.on('error', (error) => {
    options.logger.error({ err: error }, 'idle database client error')
  })
  pool.on('connect', (client) => {
    client.on('error', (error) => {
      options.logger.error({ err: error }, 'database client error')
    })
  })
  return pool
}
