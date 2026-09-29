import type { Logger as AppLogger } from '@paysync/platform'
import { Logger, runMigrations as runWorkerMigrations, type LogFunctionFactory } from 'graphile-worker'
import { sql, type SQL } from 'drizzle-orm'
import type pg from 'pg'
import { z } from 'zod'
import { ROLES } from './roles.js'
import type { Tx } from './tenancy.js'

export const JOB_SCHEMA = 'jobs'

const Uuid = z.uuid()
const OrgId = z.string().min(1).max(64)

/** Payloads of jobs the application enqueues. Cron tasks take only graphile's `_cron` payload. */
export const JOB_PAYLOADS = {
  verify_transaction: z.object({ orgId: OrgId, transactionId: Uuid }),
  apply_daraja_result: z.object({ orgId: OrgId, inboundEventId: Uuid }),
  check_stk_request: z.object({ orgId: OrgId, stkRequestId: Uuid }),
  pull_transactions: z.object({ orgId: OrgId, shortcodeId: Uuid }),
  request_balance: z.object({ orgId: OrgId, shortcodeId: Uuid }),
  match_transaction: z.object({ orgId: OrgId, transactionId: Uuid }),
  execute_reversal: z.object({ orgId: OrgId, darajaRequestId: Uuid }),
} as const

export type JobName = keyof typeof JOB_PAYLOADS

/** Retries for transient failures (Daraja or database errors), with graphile's exponential backoff. */
const MAX_ATTEMPTS: Record<JobName, number> = {
  verify_transaction: 8,
  apply_daraja_result: 8,
  check_stk_request: 5,
  pull_transactions: 5,
  request_balance: 3,
  match_transaction: 5,
  // Moves money: never retried blindly; the outcome comes from the result or Transaction Status (§5.2).
  execute_reversal: 1,
}
export type JobPayload<N extends JobName> = z.output<(typeof JOB_PAYLOADS)[N]>

export interface EnqueueOptions {
  /** Deduplicates: a job with this key that is waiting is updated rather than added again. */
  readonly jobKey?: string
  readonly jobKeyMode?: 'replace' | 'preserve_run_at' | 'unsafe_dedupe'
  readonly runAt?: Date
  readonly maxAttempts?: number
}

/**
 * Adds a job inside the caller's transaction (transactional outbox): the job
 * exists if and only if the data it processes was committed.
 */
export async function enqueueJob<N extends JobName>(
  tx: Tx,
  name: N,
  payload: JobPayload<N>,
  options: EnqueueOptions = {},
): Promise<void> {
  const body = JOB_PAYLOADS[name].parse(payload)
  const args: SQL[] = [sql`${name}`, sql`payload := ${JSON.stringify(body)}::json`]
  if (options.jobKey !== undefined) args.push(sql`job_key := ${options.jobKey}`)
  if (options.jobKeyMode !== undefined) args.push(sql`job_key_mode := ${options.jobKeyMode}`)
  if (options.runAt !== undefined) args.push(sql`run_at := ${options.runAt.toISOString()}::timestamptz`)
  args.push(sql`max_attempts := ${options.maxAttempts ?? MAX_ATTEMPTS[name]}`)
  await tx.execute(sql`SELECT FROM ${sql.raw(JOB_SCHEMA)}.add_job(${sql.join(args, sql`, `)})`)
}

const LEVELS = { error: 'error', warning: 'warn', info: 'info', debug: 'debug' } as const

export function graphileLogger(logger: AppLogger): Logger {
  const factory: LogFunctionFactory = (scope) => (level, message, meta) => {
    const method = LEVELS[level]
    logger[method]({ worker: scope, ...meta }, message)
  }
  return new Logger(factory)
}

/**
 * Installs or upgrades graphile-worker's schema as the schema owner, then
 * grants the app role what the worker and the outbox need. The app role
 * never runs DDL; a worker that finds the schema outdated fails to start.
 */
export async function installJobQueue(ownerPool: pg.Pool, logger: AppLogger): Promise<void> {
  await runWorkerMigrations({ pgPool: ownerPool, schema: JOB_SCHEMA, logger: graphileLogger(logger) })
  await ownerPool.query(`
    GRANT USAGE ON SCHEMA ${JOB_SCHEMA} TO ${ROLES.app};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${JOB_SCHEMA} TO ${ROLES.app};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${JOB_SCHEMA} TO ${ROLES.app};
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${JOB_SCHEMA} TO ${ROLES.app};
  `)
  // graphile-worker enables row-level security on its tables without policies (only the owner gets through).
  const { rows } = await ownerPool.query<{ table: string }>(
    `SELECT c.relname AS table FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND c.relrowsecurity`,
    [JOB_SCHEMA],
  )
  for (const { table } of rows) {
    const qualified = `${JOB_SCHEMA}.${escapeIdentifier(table)}`
    await ownerPool.query(`
      DROP POLICY IF EXISTS app_worker ON ${qualified};
      CREATE POLICY app_worker ON ${qualified} TO ${ROLES.app} USING (true) WITH CHECK (true);
    `)
  }
}

function escapeIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}
