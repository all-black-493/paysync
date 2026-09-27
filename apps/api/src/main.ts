import { inspect } from 'node:util'
import { createAuth } from './auth.js'
import { createDb, createPool, loadMigrations } from '@paysync/db'
import {
  ConfigError,
  DATABASE_SECRETS,
  closeServer,
  commonEnvShape,
  createLogger,
  createSealer,
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
  PUBLIC_URL: z.url().refine((u) => !u.endsWith('/'), 'no trailing slash'),
  BETTER_AUTH_SECRET: z.string().min(32),
  API_DOCS: z.enum(['on', 'off']).default('off'),
  CALLBACK_PATH_SECRET: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/, 'at least 32 URL-safe characters'),
  DATA_ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/, '64 hex characters'),
  DARAJA_ENV: z.literal('sandbox').default('sandbox'),
  CALLBACK_ALLOWED_IPS: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
})

async function main(): Promise<void> {
  const config = loadConfig(configSchema, {
    secrets: [...DATABASE_SECRETS, 'BETTER_AUTH_SECRET', 'CALLBACK_PATH_SECRET', 'DATA_ENCRYPTION_KEY'],
  })
  const logger = createLogger({ service: 'api', level: config.LOG_LEVEL })
  const pool = createPool({
    url: config.DATABASE_URL,
    password: config.DATABASE_PASSWORD,
    max: config.DB_POOL_MAX,
    applicationName: 'paysync-api',
    logger,
  })
  const db = createDb(pool)
  const auth = createAuth({ db, secret: config.BETTER_AUTH_SECRET, baseURL: config.PUBLIC_URL })
  const { server, health } = createApiServer({
    pool,
    db,
    auth,
    migrations: loadMigrations(),
    logger,
    publicUrl: config.PUBLIC_URL,
    docs: config.API_DOCS === 'on' && config.NODE_ENV !== 'production',
    hooks: {
      callbackSecret: config.CALLBACK_PATH_SECRET,
      allowedIps: config.CALLBACK_ALLOWED_IPS,
      environment: config.DARAJA_ENV,
      pii: createSealer(config.DATA_ENCRYPTION_KEY, 'pii'),
    },
  })

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
  logger.info({ port: config.PORT, docs: config.API_DOCS }, 'api listening')
}

main().catch((error: unknown) => {
  const message = error instanceof ConfigError ? error.message : inspect(error)
  process.stderr.write(`api failed to start: ${message}\n`)
  process.exit(1)
})
