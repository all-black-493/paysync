import { raiseException, schema, withOrg, type JobPayload } from '@paysync/db'
import { applyMatch, decide, loadCandidates, lockTransaction, type Decision } from '@paysync/matching'
import { and, eq } from 'drizzle-orm'
import type { WorkerDeps } from './deps.js'

const { match } = schema

export type MatchOutcome = Decision['kind'] | 'skipped'

const FOLLOW_UP_SUMMARY = {
  partial_payment: 'paid less than the amount due; the balance is still open',
  overpayment: 'paid more than the amount due; the rest is unallocated',
} as const

/**
 * Deterministic matching (exact, then rules) for a verified payment. Runs
 * serializable: a concurrent match for the same payment or expected payment
 * retries instead of over-allocating.
 */
export async function matchTransaction(deps: WorkerDeps, { orgId, transactionId }: JobPayload<'match_transaction'>): Promise<MatchOutcome> {
  const outcome = await withOrg(
    deps.db,
    orgId,
    async (tx): Promise<MatchOutcome> => {
      const payment = await lockTransaction(tx, transactionId)
      if (payment?.status !== 'verified') return 'skipped'
      const [active] = await tx
        .select({ id: match.id })
        .from(match)
        .where(and(eq(match.transactionId, transactionId), eq(match.status, 'active')))
        .limit(1)
      if (active) return 'skipped'

      const decision = decide(payment, await loadCandidates(tx), deps.matchPolicy)
      if (decision.kind === 'nothing_to_allocate') return decision.kind
      if (decision.kind === 'exception') {
        await raiseException(tx, {
          orgId,
          kind: decision.exception,
          priority: decision.exception === 'duplicate' ? 'high' : 'normal',
          summary: `Payment ${payment.receiptNumber}: ${decision.explanation}`,
          transactionId,
          details: { reason: decision.explanation, candidateIds: [...decision.candidateIds] },
          dedupeKey: `match:${transactionId}`,
        })
        return decision.kind
      }
      await applyMatch(tx, {
        orgId,
        transactionId,
        method: decision.method,
        parts: [{ expectedPaymentId: decision.expectedPaymentId, amount: decision.amount }],
        createdBy: `matching:${decision.method}`,
      })
      if (decision.followUp) {
        await raiseException(tx, {
          orgId,
          kind: decision.followUp,
          priority: 'normal',
          summary: `Payment ${payment.receiptNumber} ${FOLLOW_UP_SUMMARY[decision.followUp]}`,
          transactionId,
          expectedPaymentId: decision.expectedPaymentId,
          details: { reason: decision.explanation },
          dedupeKey: `${decision.followUp}:${transactionId}`,
        })
      }
      return decision.kind
    },
    { isolation: 'serializable' },
  )
  deps.logger.info({ transactionId, outcome }, 'matching')
  return outcome
}
