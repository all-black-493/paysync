import { createDb } from '@paysync/db'
import pg from 'pg'
import { createAuth } from './src/auth.js'

// The OAuth provider seeds its resource table on start-up; here there is no table yet, and nothing to seed.
process.on('unhandledRejection', (error) => {
  if (error instanceof Error && error.message.includes('was not found in the schema object')) return
  throw error
})

// Only used by `make auth-schema`; nothing connects to this pool.
export const auth = createAuth({
  db: createDb(new pg.Pool()),
  secret: 'schema-generation-only-not-a-secret',
  baseURL: 'http://localhost',
})
