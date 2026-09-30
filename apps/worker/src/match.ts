import { chooseCandidate, JevError, type CandidateChoice } from '@paysync/decisions'
import { raiseException, schema, withOrg, type JobPayload, type Tx } from '@paysync/db'
import {
  afterJev,
  applyMatch,
  decide,
  jevCandidates,
  loadCandidates,
  lockTransaction,
  needsJev,
  type Candidate,
  type Decision,
  type ExceptionDecision,
  type TransactionForMatching,
} from '@paysync/matching'
import { and, eq } from 'drizzle-orm'
import type { WorkerDeps } from './deps.js'

const { match } = schema

export type MatchOutcome = Decision['kind'] | 'skipped'

const FOLLOW_UP_SUMMARY = {
  partial_payment: 'paid less than the amount due; the balance is still open',
  overpayment: 'paid more than the amount due; the rest is unallocated',
} as const

/** What the first pass leaves for Jev: the payment as it was read, the fallback, and who to ask about. */
interface AskJev {
  readonly payment: TransactionForMatching
  readonly pool: readonly Candidate[]
  readonly fallback: ExceptionDecision
}

type FirstPass = { readonly done: MatchOutcome } | { readonly ask: AskJev }

/**
 * Matching for a verified payment (§7.1): exact and rules in one serializable
 * transaction; when they cannot place it, Jev is asked outside any transaction
 * (§6B.5), then a second transaction re-reads everything and applies §7.3.
 */
export async function matchTransaction(deps: WorkerDeps, job: JobPayload<'match_transaction'>): Promise<MatchOutcome> {
  const first = await withOrg(deps.db, job.orgId, (tx) => firstPass(tx, deps, job), { isolation: 'serializable' })
  if ('done' in first) return logged(deps, job.transactionId, first.done)

  const choice = await ask(deps, first.ask)
  const outcome = await withOrg(deps.db, job.orgId, (tx) => secondPass(tx, deps, job, first.ask, choice), { isolation: 'serializable' })
  return logged(deps, job.transactionId, outcome)
}

function logged(deps: WorkerDeps, transactionId: string, outcome: MatchOutcome): MatchOutcome {
  deps.logger.info({ transactionId, outcome }, 'matching')
  return outcome
}

async function unmatched(tx: Tx, transactionId: string): Promise<TransactionForMatching | null> {
  const payment = await lockTransaction(tx, transactionId)
  if (payment?.status !== 'verified') return null
  const [active] = await tx
    .select({ id: match.id })
    .from(match)
    .where(and(eq(match.transactionId, transactionId), eq(match.status, 'active')))
    .limit(1)
  return active ? null : payment
}

async function firstPass(tx: Tx, deps: WorkerDeps, job: JobPayload<'match_transaction'>): Promise<FirstPass> {
  const payment = await unmatched(tx, job.transactionId)
  if (!payment) return { done: 'skipped' }
  const candidates = await loadCandidates(tx)
  const decision = decide(payment, candidates, deps.matchPolicy)
  if (needsJev(payment, decision)) {
    const pool = jevCandidates(payment, candidates, deps.matchPolicy)
    if (pool.length > 0) return { ask: { payment, pool, fallback: decision } }
  }
  return { done: await record(tx, job, payment, decision) }
}

/** Jev's answer, or null on any failure: the deterministic exception then stands (fail closed). */
async function ask(deps: WorkerDeps, { payment, pool }: AskJev): Promise<CandidateChoice | null> {
  try {
    return await chooseCandidate(
      deps.jev,
      { reference: payment.reference ?? '' },
      pool.map((c) => ({ id: c.id, reference: c.reference, description: c.description ?? null })),
      { timeoutMs: deps.matchPolicy.jev.timeoutMs },
    )
  } catch (error) {
    if (!(error instanceof JevError)) throw error
    if (error.kind !== 'not_configured') deps.logger.warn({ transactionId: payment.id, failure: error.kind }, 'jev matching unavailable')
    return null
  }
}

async function secondPass(
  tx: Tx,
  deps: WorkerDeps,
  job: JobPayload<'match_transaction'>,
  asked: AskJev,
  choice: CandidateChoice | null,
): Promise<MatchOutcome> {
  const payment = await unmatched(tx, job.transactionId)
  if (!payment) return 'skipped'
  // Changed while Jev was answering: its answer is about an old picture, so the deterministic tiers decide on the new one.
  if (payment.version !== asked.payment.version || payment.allocated !== asked.payment.allocated) {
    return record(tx, job, payment, decide(payment, await loadCandidates(tx), deps.matchPolicy))
  }
  const fresh = await loadCandidates(tx, asked.pool.map((c) => c.id))
  const decision = choice ? afterJev(payment, fresh, choice, asked.fallback, deps.matchPolicy) : asked.fallback
  return record(tx, job, payment, decision)
}

async function record(tx: Tx, job: JobPayload<'match_transaction'>, payment: TransactionForMatching, decision: Decision): Promise<MatchOutcome> {
  const { orgId, transactionId } = job
  if (decision.kind === 'nothing_to_allocate') return decision.kind
  if (decision.kind === 'exception') {
    await raiseException(tx, {
      orgId,
      kind: decision.exception,
      priority: decision.exception === 'duplicate' ? 'high' : 'normal',
      summary: `Payment ${payment.receiptNumber}: ${decision.explanation}`,
      transactionId,
      details: { reason: decision.explanation, candidateIds: [...decision.candidateIds], ...(decision.evidence ? { jev: decision.evidence } : {}) },
      dedupeKey: `match:${transactionId}`,
    })
    return decision.kind
  }
  await applyMatch(tx, {
    orgId,
    transactionId,
    expectedVersion: payment.version,
    method: decision.method,
    parts: [{ expectedPaymentId: decision.expectedPaymentId, amount: decision.amount }],
    createdBy: `matching:${decision.method}`,
    ...(decision.evidence ? { jev: { confidence: decision.evidence.confidence, probabilities: decision.evidence.probabilities } } : {}),
  })
  if (decision.followUp) {
    await raiseException(tx, {
      orgId,
      kind: decision.followUp,
      priority: 'normal',
      summary: `Payment ${payment.receiptNumber} ${FOLLOW_UP_SUMMARY[decision.followUp]}`,
      transactionId,
      expectedPaymentId: decision.expectedPaymentId,
      details: { reason: decision.explanation, ...(decision.evidence ? { jev: decision.evidence } : {}) },
      dedupeKey: `${decision.followUp}:${transactionId}`,
    })
  }
  return decision.kind
}
