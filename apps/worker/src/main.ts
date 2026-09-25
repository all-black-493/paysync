import { inspect } from 'node:util'
import { checkMigrations, createPool, loadMigrations } from '@paysync/db'
import {
  ConfigError,
  DATABASE_SECRETS,
  closeServer,
  commonEnvShape,
  createHealthRoutes,
  createHealthServer,
  createLogger,
  databaseEnvShape,
  installGracefulShutdown,
  listen,
  loadConfig,
} from '@paysync/platform'
import { z } from 'zod'

const configSchema = z.object({
  ...commonEnvShape,
  ...databaseEnvShape,
  HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(30_000),
})

async function main(): Promise<void> {
  const config = loadConfig(configSchema, { secrets: DATABASE_SECRETS })
  const logger = createLogger({ service: 'worker', level: config.LOG_LEVEL })
  const pool = createPool({
    url: config.DATABASE_URL,
    password: config.DATABASE_PASSWORD,
    max: config.DB_POOL_MAX,
    applicationName: 'paysync-worker',
    logger,
  })
  const migrations = loadMigrations()

  const health = createHealthRoutes({
    checks: [
      {
        name: 'migrations',
        run: async () => {
          const status = await checkMigrations(pool, migrations)
          return status.ok ? { ok: true } : { ok: false, detail: `missing: ${status.missing.join(', ')}` }
        },
      },
    ],
  })
  const server = createHealthServer(health)

  installGracefulShutdown({
    logger,
    timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
    steps: [
      {
        name: 'stop reporting ready',
        run: () => {
          health.startDraining()
          return Promise.resolve()
        },
      },
      { name: 'close health server', run: () => closeServer(server) },
      { name: 'close database pool', run: () => pool.end() },
    ],
  })

  await listen(server, config.HEALTH_PORT)
  logger.info({ healthPort: config.HEALTH_PORT }, 'worker started (no tasks until M3)')
}

main().catch((error: unknown) => {
  const message = error instanceof ConfigError ? error.message : inspect(error)
  process.stderr.write(`worker failed to start: ${message}\n`)
  process.exit(1)
})
