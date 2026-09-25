import { inspect } from 'node:util'
import { runMigrations } from '@paysync/db'
import {
  ConfigError,
  DATABASE_SECRETS,
  commonEnvShape,
  createLogger,
  databaseConnectionParams,
  databaseEnvShape,
  loadConfig,
} from '@paysync/platform'
import pg from 'pg'
import { z } from 'zod'

const configSchema = z.object({ ...commonEnvShape, ...databaseEnvShape })

async function main(): Promise<void> {
  const config = loadConfig(configSchema, { secrets: DATABASE_SECRETS })
  const logger = createLogger({ service: 'migrate', level: config.LOG_LEVEL })
  const client = new pg.Client({
    ...databaseConnectionParams(config.DATABASE_URL, config.DATABASE_PASSWORD),
    application_name: 'paysync-migrate',
  })
  await client.connect()
  try {
    const result = await runMigrations(client, logger)
    logger.info({ applied: result.applied, alreadyApplied: result.alreadyApplied }, 'migrations complete')
  } finally {
    await client.end()
  }
}

main().catch((error: unknown) => {
  const message = error instanceof ConfigError ? error.message : inspect(error)
  process.stderr.write(`migrate failed: ${message}\n`)
  process.exit(1)
})
