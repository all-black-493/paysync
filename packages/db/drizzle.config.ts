import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  migrations: {
    prefix: 'timestamp',
    schema: 'meta',
    table: 'schema_migration',
  },
  strict: true,
  verbose: true,
})
