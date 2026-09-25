import { createDb } from '@paysync/db'
import pg from 'pg'
import { createAuth } from './src/auth.js'

// Only used by `make auth-schema`; nothing connects to this pool.
export const auth = createAuth({
  db: createDb(new pg.Pool()),
  secret: 'schema-generation-only-not-a-secret',
  baseURL: 'http://localhost',
})
