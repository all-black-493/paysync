import type { CandidateChoice } from '@paysync/decisions'
import {
  exception,
  isOpen,
  remaining,
  settle,
  withinWindow,
  type Candidate,
  type Decision,
  type ExceptionDecision,
  type JevEvidence,
  type MatchPolicy,
  type PaymentFacts,
} from './decide.js'
import { normalizeReference } from './reference.js'

/** Jev only sees payments the deterministic tiers could not place, and only when there is a reference to read. */
export function needsJev(payment: PaymentFacts, decision: Decision): decision is ExceptionDecision {
  if (decision.kind !== 'exception') return false
  if (decision.exception !== 'no_match' && decision.exception !== 'low_confidence') return false
  return normalizeReference(payment.reference ?? '') !== ''
}

/**
 * The open expected payments worth asking about: in the date window, with
 * something still due, closest in amount and then in date. Code does the
 * numbers; Jev only compares references.
 */
export function jevCandidates(payment: PaymentFacts, candidates: readonly Candidate[], policy: MatchPolicy): Candidate[] {
  const available = payment.amount - payment.allocated
  const distance = (c: Candidate) => {
    const d = remaining(c) - available
    return d < 0n ? -d : d
  }
  const days = (c: Candidate) => (c.dueDate === null ? Number.MAX_SAFE_INTEGER : Math.abs(payment.transactedAt.getTime() - Date.parse(`${c.dueDate}T00:00:00+03:00`)))
  return candidates
    .filter((c) => isOpen(c) && remaining(c) > 0n && withinWindow(c, payment.transactedAt, policy.dateWindowDays))
    .sort((a, b) => {
      const byAmount = distance(a) - distance(b)
      return byAmount !== 0n ? (byAmount < 0n ? -1 : 1) : days(a) - days(b)
    })
    .slice(0, policy.jev.maxCandidates)
}

function evidenceOf(choice: CandidateChoice): JevEvidence {
  return { model: choice.model, candidateId: choice.candidateId, confidence: choice.confidence, probabilities: choice.probabilities, injection: choice.injection }
}

const percent = (p: number) => `${String(Math.round(p * 100))}%`

/**
 * §7.3 after Jev answered, against a fresh read of the candidates. Jev can
 * only move a payment towards a person or, above the auto-match bar, into the
 * same amount rule every other tier uses. Anything doubtful keeps the
 * deterministic exception, with Jev's answer attached.
 */
export function afterJev(
  payment: PaymentFacts,
  pool: readonly Candidate[],
  choice: CandidateChoice,
  fallback: ExceptionDecision,
  policy: MatchPolicy,
): Decision {
  const evidence = evidenceOf(choice)
  const keep = (why: string): ExceptionDecision => ({ ...fallback, explanation: `${fallback.explanation} ${why}`, evidence })

  if (choice.injection > policy.jev.injection) return keep('The reference reads like instructions, so it was not matched automatically.')
  if (choice.candidateId === null) return keep('Jev found none of the open expected payments a fit.')
  const chosen = pool.find((c) => c.id === choice.candidateId)
  if (!chosen || !isOpen(chosen) || !withinWindow(chosen, payment.transactedAt, policy.dateWindowDays)) {
    return keep('The expected payment Jev suggested is no longer open.')
  }
  if (choice.confidence < policy.jev.suggest) return keep(`Jev was unsure (${percent(choice.confidence)}).`)
  if (choice.confidence < policy.jev.autoMatch) {
    return { ...exception('low_confidence', `Possibly ${chosen.reference} (Jev ${percent(choice.confidence)} sure); a person should confirm.`, [chosen]), evidence }
  }

  const decided = settle(chosen, payment.amount - payment.allocated, 'jev', policy, {
    full: `Jev matched the reference to ${chosen.reference} (${percent(choice.confidence)}), and the amount is what is due.`,
    partial: `Jev matched the reference to ${chosen.reference} (${percent(choice.confidence)}); the payment covers part of the amount due.`,
    over: `Jev matched the reference to ${chosen.reference} (${percent(choice.confidence)}); the rest stays unallocated.`,
  })
  return { ...decided, evidence }
}
