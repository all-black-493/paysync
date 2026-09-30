import { inspect } from 'node:util'
import { DarajaClient, createSecurityCredential, credentialIdFor, darajaCertificate } from '@paysync/daraja'
import {
  JOB_SCHEMA,
  checkMigrations,
  createDarajaTokenStore,
  createDb,
  createPool,
  graphileLogger,
  loadMigrations,
} from '@paysync/db'
import {
  ConfigError,
  DATABASE_SECRETS,
  closeServer,
  commonEnvShape,
  jevEnvShape,
  jevSecrets,
  createHealthRoutes,
  createHealthServer,
  createLogger,
  createSealer,
  databaseEnvShape,
  installGracefulShutdown,
  listen,
  loadConfig,
} from '@paysync/platform'
import { jevFromConfig } from '@paysync/decisions'
import { DEFAULT_MATCH_POLICY } from '@paysync/matching'
import { run } from 'graphile-worker'
import { z } from 'zod'
import { DEFAULT_POLICY, resultUrlsFor, type WorkerDeps } from './deps.js'
import { CRONTAB, reportFailedJob, taskList } from './tasks.js'

const configSchema = z.object({
  ...commonEnvShape,
  ...databaseEnvShape,
  HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(30_000),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  DARAJA_ENV: z.literal('sandbox').default('sandbox'),
  DARAJA_CONSUMER_KEY: z.string().min(8),
  DARAJA_CONSUMER_SECRET: z.string().min(8),
  DARAJA_PASSKEY: z.string().min(8),
  DARAJA_INITIATOR_NAME: z.string().max(64).default(''),
  DARAJA_INITIATOR_PASSWORD: z.string().min(1),
  CALLBACK_PATH_SECRET: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/, 'at least 32 URL-safe characters'),
  CALLBACK_BASE_URL: z.preprocess((v) => (v === '' ? undefined : v), z.url().optional()),
  DATA_ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/, '64 hex characters'),

  ...jevEnvShape,
})

const SECRETS = [
  ...DATABASE_SECRETS,
  'DARAJA_CONSUMER_KEY',
  'DARAJA_CONSUMER_SECRET',
  'DARAJA_PASSKEY',
  'DARAJA_INITIATOR_PASSWORD',
  'CALLBACK_PATH_SECRET',
  'DATA_ENCRYPTION_KEY',
]

async function main(): Promise<void> {
  const config = loadConfig(configSchema, { secrets: [...SECRETS, ...jevSecrets()] })
  const logger = createLogger({ service: 'worker', level: config.LOG_LEVEL })
  const pool = createPool({
    url: config.DATABASE_URL,
    password: config.DATABASE_PASSWORD,
    max: Math.max(config.DB_POOL_MAX, config.WORKER_CONCURRENCY + 2),
    applicationName: 'paysync-worker',
    logger,
  })
  const db = createDb(pool)
  const environment = config.DARAJA_ENV
  const initiator =
    config.DARAJA_INITIATOR_NAME === ''
      ? undefined
      : {
          name: config.DARAJA_INITIATOR_NAME,
          securityCredential: createSecurityCredential(config.DARAJA_INITIATOR_PASSWORD, darajaCertificate(environment)),
        }
  const deps: WorkerDeps = {
    db,
    logger,
    environment,
    pii: createSealer(config.DATA_ENCRYPTION_KEY, 'pii'),
    daraja: new DarajaClient({
      environment,
      credentialId: credentialIdFor(environment, config.DARAJA_CONSUMER_KEY),
      credentials: {
        consumerKey: config.DARAJA_CONSUMER_KEY,
        consumerSecret: config.DARAJA_CONSUMER_SECRET,
        passkey: config.DARAJA_PASSKEY,
      },
      tokenStore: createDarajaTokenStore(pool, createSealer(config.DATA_ENCRYPTION_KEY, 'daraja-token')),
      logger,
      ...(initiator ? { initiator } : {}),
    }),
    resultUrls: config.CALLBACK_BASE_URL ? resultUrlsFor(config.CALLBACK_BASE_URL, config.CALLBACK_PATH_SECRET) : null,
    policy: DEFAULT_POLICY,
    matchPolicy: DEFAULT_MATCH_POLICY,
    jev: jevFromConfig(config),
    now: () => new Date(),
  }
  if (!config.JEV_ENABLED) logger.warn('JEV_ENABLED is off: the Jev matching tier is skipped')
  if (!deps.resultUrls) logger.warn('CALLBACK_BASE_URL is not set: Transaction Status and Account Balance requests are disabled')
  if (!initiator) logger.warn('DARAJA_INITIATOR_NAME is not set: Transaction Status and Account Balance requests are disabled')

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

  const runner = await run({
    pgPool: pool,
    schema: JOB_SCHEMA,
    concurrency: config.WORKER_CONCURRENCY,
    noHandleSignals: true,
    logger: graphileLogger(logger),
    taskList: taskList(deps),
    crontab: CRONTAB,
  })
  runner.events.on('job:failed', ({ job, error }) => {
    reportFailedJob(deps, job, error).catch((err: unknown) => {
      logger.error({ err, jobId: job.id }, 'could not record a failed job as an exception')
    })
  })

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
      { name: 'finish running jobs', run: () => runner.stop() },
      { name: 'close health server', run: () => closeServer(server) },
      { name: 'close database pool', run: () => pool.end() },
    ],
  })

  await listen(server, config.HEALTH_PORT)
  logger.info({ healthPort: config.HEALTH_PORT, concurrency: config.WORKER_CONCURRENCY }, 'worker started')
}

main().catch((error: unknown) => {
  const message = error instanceof ConfigError ? error.message : inspect(error)
  process.stderr.write(`worker failed to start: ${message}\n`)
  process.exit(1)
})
