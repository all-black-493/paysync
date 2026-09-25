import { inspect } from 'node:util'
import { createPool, loadMigrations } from '@paysync/db'
import {
  ConfigError,
  DATABASE_SECRETS,
  closeServer,
  commonEnvShape,
  createLogger,
  databaseEnvShape,
  installGracefulShutdown,
  listen,
  loadConfig,
} from '@paysync/platform'
import { z } from 'zod'
import { createApiServer } from './server.js'

const configSchema = z.object({
  ...commonEnvShape,
  ...databaseEnvShape,
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(15_000),
})

async function main(): Promise<void> {
  const config = loadConfig(configSchema, { secrets: DATABASE_SECRETS })
  const logger = createLogger({ service: 'api', level: config.LOG_LEVEL })
  const pool = createPool({
    url: config.DATABASE_URL,
    password: config.DATABASE_PASSWORD,
    max: config.DB_POOL_MAX,
    applicationName: 'paysync-api',
    logger,
  })
  const { server, health } = createApiServer({ pool, migrations: loadMigrations(), logger })

  installGracefulShutdown({
    logger,
    timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
    steps: [
      {
        name: 'stop accepting requests',
        run: () => {
          health.startDraining()
          return Promise.resolve()
        },
      },
      { name: 'finish in-flight requests', run: () => closeServer(server) },
      { name: 'close database pool', run: () => pool.end() },
    ],
  })

  await listen(server, config.PORT)
  logger.info({ port: config.PORT }, 'api listening')
}

main().catch((error: unknown) => {
  const message = error instanceof ConfigError ? error.message : inspect(error)
  process.stderr.write(`api failed to start: ${message}\n`)
  process.exit(1)
})
