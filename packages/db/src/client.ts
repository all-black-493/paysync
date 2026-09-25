import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import type pg from 'pg'
import * as schema from './schema/index.js'

export type Schema = typeof schema
export type Db = NodePgDatabase<Schema>

export function createDb(pool: pg.Pool): Db {
  return drizzle({ client: pool, schema, casing: 'snake_case' })
}
