import { JOB_PAYLOADS, raiseException, withOrg } from '@paysync/db'
import type { Job, Task, TaskList } from 'graphile-worker'
import { z } from 'zod'
import { requestBalance } from './balance.js'
import type { WorkerDeps } from './deps.js'
import { matchTransaction } from './match.js'
import { pullTransactions } from './pull.js'
import { applyDarajaResult } from './results/index.js'
import { executeReversal } from './reversal.js'
import { checkStkRequest } from './stk.js'
import { sweepBalances, sweepPendingActions, sweepPull, sweepStkRequests, sweepUnverified } from './sweeps.js'
import { verifyTransaction } from './verify.js'

function job<S extends z.ZodType>(deps: WorkerDeps, schema: S, run: (deps: WorkerDeps, payload: z.output<S>) => Promise<unknown>): Task {
  return async (payload) => {
    await run(deps, schema.parse(payload))
  }
}

function cron(deps: WorkerDeps, run: (deps: WorkerDeps) => Promise<unknown>): Task {
  return async () => {
    await run(deps)
  }
}

export function taskList(deps: WorkerDeps): TaskList {
  return {
    verify_transaction: job(deps, JOB_PAYLOADS.verify_transaction, verifyTransaction),
    apply_daraja_result: job(deps, JOB_PAYLOADS.apply_daraja_result, applyDarajaResult),
    check_stk_request: job(deps, JOB_PAYLOADS.check_stk_request, checkStkRequest),
    pull_transactions: job(deps, JOB_PAYLOADS.pull_transactions, pullTransactions),
    request_balance: job(deps, JOB_PAYLOADS.request_balance, requestBalance),
    match_transaction: job(deps, JOB_PAYLOADS.match_transaction, matchTransaction),
    execute_reversal: job(deps, JOB_PAYLOADS.execute_reversal, executeReversal),
    sweep_unverified: cron(deps, sweepUnverified),
    sweep_stk_requests: cron(deps, sweepStkRequests),
    sweep_pull: cron(deps, sweepPull),
    sweep_balances: cron(deps, sweepBalances),
    sweep_pending_actions: cron(deps, sweepPendingActions),
  }
}

// UTC. Balances at 15:00 UTC = 18:00 EAT. Sweeps are idempotent, so a short backfill is safe.
export const CRONTAB = `
*/10 * * * * sweep_unverified ?id=sweep_unverified&fill=30m&max=3
*/10 * * * * sweep_stk_requests ?id=sweep_stk_requests&fill=30m&max=3
7 * * * * sweep_pull ?id=sweep_pull&fill=2h&max=3
0 15 * * * sweep_balances ?id=sweep_balances&fill=6h&max=3
17 * * * * sweep_pending_actions ?id=sweep_pending_actions&fill=2h&max=3
`

const WithOrg = z.object({ orgId: z.string().min(1) })

/** Called on graphile's job:failed (out of retries). The job becomes an exception in the queue humans work, never a silent dead letter. */
export async function reportFailedJob(deps: WorkerDeps, failed: Job, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error)
  deps.logger.error({ jobId: failed.id, task: failed.task_identifier, attempts: failed.attempts, err: error }, 'job failed permanently')
  const payload = WithOrg.safeParse(failed.payload)
  if (!payload.success) return
  await withOrg(deps.db, payload.data.orgId, (tx) =>
    raiseException(tx, {
      orgId: payload.data.orgId,
      kind: 'job_failed',
      priority: 'high',
      summary: `Background task ${failed.task_identifier} failed after ${failed.attempts} attempts`,
      details: { jobId: failed.id, task: failed.task_identifier, error: message.slice(0, 500) },
      dedupeKey: `job_failed:${failed.id}`,
    }),
  )
}
