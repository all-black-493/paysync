import type { Candidate, PaymentFacts } from './decide.js'
import { normalizeReference, referenceKey } from './reference.js'

export type SuggestionReason =
  | 'same_reference'
  | 'same_reference_normalized'
  | 'similar_reference'
  | 'amount_equals_due'
  | 'amount_below_due'
  | 'due_date_near'

export interface Suggestion {
  readonly expectedPaymentId: string
  /** 0–1, from fixed weights; ranks candidates, never decides. */
  readonly score: number
  readonly reasons: readonly SuggestionReason[]
  /** What confirming would allocate: the payment's unallocated amount, capped at the amount due. */
  readonly amount: bigint
}

const WEIGHTS: Record<SuggestionReason, number> = {
  same_reference: 0.6,
  same_reference_normalized: 0.45,
  similar_reference: 0.25,
  amount_equals_due: 0.3,
  amount_below_due: 0.1,
  due_date_near: 0.1,
}

const NEAR_MS = 31 * 24 * 60 * 60 * 1000

/** Ranked open candidates for a person (or, later, Jev) to choose from. Changes nothing. */
export function suggest(payment: PaymentFacts, candidates: readonly Candidate[], limit = 10): Suggestion[] {
  const available = payment.amount - payment.allocated
  if (available <= 0n) return []
  const reference = payment.reference ?? ''
  const normalized = normalizeReference(reference)
  const key = referenceKey(reference)

  const suggestions: Suggestion[] = []
  for (const c of candidates) {
    if (c.status !== 'open' && c.status !== 'partially_paid') continue
    const due = c.amountDue - c.paid
    if (due <= 0n) continue
    const reasons: SuggestionReason[] = []
    const candidateKey = referenceKey(c.reference)
    if (normalized !== '' && normalizeReference(c.reference) === normalized) reasons.push('same_reference')
    else if (key !== '' && candidateKey === key) reasons.push('same_reference_normalized')
    else if (key.length >= 3 && candidateKey.length >= 3 && (key.includes(candidateKey) || candidateKey.includes(key))) {
      reasons.push('similar_reference')
    }
    const referenceFits = reasons.length > 0
    if (available === due) reasons.push('amount_equals_due')
    else if (available < due) reasons.push('amount_below_due')
    // An amount alone only counts when it is exactly the amount due.
    if (!referenceFits && !reasons.includes('amount_equals_due')) continue
    if (c.dueDate !== null && Math.abs(payment.transactedAt.getTime() - Date.parse(`${c.dueDate}T00:00:00+03:00`)) <= NEAR_MS) {
      reasons.push('due_date_near')
    }
    const score = Math.min(1, reasons.reduce((sum, r) => sum + WEIGHTS[r], 0))
    suggestions.push({ expectedPaymentId: c.id, score: Math.round(score * 100) / 100, reasons, amount: available < due ? available : due })
  }
  return suggestions.sort((a, b) => b.score - a.score || a.expectedPaymentId.localeCompare(b.expectedPaymentId)).slice(0, limit)
}
