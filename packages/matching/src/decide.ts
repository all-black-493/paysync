import { normalizeReference, referenceKey } from './reference.js'

export interface PaymentFacts {
  readonly amount: bigint
  /** Already allocated to active matches. */
  readonly allocated: bigint
  /** Typed by the payer: untrusted, only ever compared. */
  readonly reference: string | null
  readonly transactedAt: Date
}

export interface Candidate {
  readonly id: string
  readonly reference: string
  readonly amountDue: bigint
  readonly paid: bigint
  /** YYYY-MM-DD */
  readonly dueDate: string | null
  readonly status: 'open' | 'partially_paid' | 'paid' | 'void'
}

export interface MatchPolicy {
  /** A due date further than this from the payment rules the candidate out. */
  readonly dateWindowDays: number
  /** Allocate a payment below the amount due and flag the balance, rather than leave it unmatched. */
  readonly allocatePartial: boolean
  /** Allocate up to the amount due and flag the unallocated rest, rather than leave it unmatched. */
  readonly allocateOverpayment: boolean
}

export const DEFAULT_MATCH_POLICY: MatchPolicy = {
  dateWindowDays: 120,
  allocatePartial: true,
  allocateOverpayment: true,
}

export type FollowUp = 'partial_payment' | 'overpayment'
export type ExceptionReason = 'no_match' | 'low_confidence' | 'duplicate' | 'partial_payment' | 'overpayment'

export type Decision =
  | {
      readonly kind: 'match'
      readonly method: 'exact' | 'rule'
      readonly expectedPaymentId: string
      readonly amount: bigint
      readonly followUp: FollowUp | null
      readonly explanation: string
    }
  | {
      readonly kind: 'exception'
      readonly exception: ExceptionReason
      readonly explanation: string
      readonly candidateIds: readonly string[]
    }
  | { readonly kind: 'nothing_to_allocate' }

const DAY_MS = 24 * 60 * 60 * 1000

const remaining = (c: Candidate) => c.amountDue - c.paid
const isOpen = (c: Candidate) => c.status === 'open' || c.status === 'partially_paid'

function withinWindow(c: Candidate, at: Date, days: number): boolean {
  if (c.dueDate === null) return true
  const due = Date.parse(`${c.dueDate}T00:00:00+03:00`)
  return Math.abs(at.getTime() - due) <= days * DAY_MS
}

const exception = (reason: ExceptionReason, explanation: string, candidates: readonly Candidate[] = []): Decision => ({
  kind: 'exception',
  exception: reason,
  explanation,
  candidateIds: candidates.map((c) => c.id),
})

/**
 * Deterministic tiers of the matching pipeline (§7.1): exact, then rules.
 * Only one open candidate can be auto-matched; anything ambiguous becomes an
 * exception. Allocation amounts are always computed here, never guessed.
 */
export function decide(payment: PaymentFacts, candidates: readonly Candidate[], policy: MatchPolicy = DEFAULT_MATCH_POLICY): Decision {
  const available = payment.amount - payment.allocated
  if (available <= 0n) return { kind: 'nothing_to_allocate' }
  const reference = payment.reference?.trim() ?? ''
  if (normalizeReference(reference) === '') return exception('no_match', 'The payment has no usable reference.')

  const normalized = normalizeReference(reference)
  const key = referenceKey(reference)
  const byKey = candidates.filter((c) => referenceKey(c.reference) === key)
  const open = byKey.filter(isOpen)
  const inWindow = open.filter((c) => withinWindow(c, payment.transactedAt, policy.dateWindowDays))

  if (inWindow.length === 0) {
    if (open.length > 0) return exception('low_confidence', 'The reference matches, but the due date is far from the payment date.', open)
    const settled = byKey.filter((c) => c.status === 'paid' && c.amountDue === available)
    if (settled.length > 0) return exception('duplicate', 'The reference and amount match an expected payment that is already paid.', settled)
    return exception('no_match', 'No open expected payment has this reference.')
  }

  // Several sharing the key: the one written exactly the same way wins, if there is exactly one.
  const same = inWindow.filter((c) => normalizeReference(c.reference) === normalized)
  const chosen = inWindow.length === 1 ? inWindow[0] : same.length === 1 ? same[0] : undefined
  if (!chosen) return exception('low_confidence', 'Several open expected payments fit this reference.', inWindow)

  const due = remaining(chosen)
  const exact = normalizeReference(chosen.reference) === normalized
  if (available === due) {
    return {
      kind: 'match',
      method: exact ? 'exact' : 'rule',
      expectedPaymentId: chosen.id,
      amount: available,
      followUp: null,
      explanation: exact ? 'Same reference and the amount due.' : 'Same reference once normalized, and the amount due.',
    }
  }
  if (available < due) {
    if (!policy.allocatePartial) return exception('partial_payment', 'The payment is less than the amount due.', [chosen])
    return {
      kind: 'match',
      method: 'rule',
      expectedPaymentId: chosen.id,
      amount: available,
      followUp: 'partial_payment',
      explanation: 'Reference matches; the payment covers part of the amount due.',
    }
  }
  if (!policy.allocateOverpayment) return exception('overpayment', 'The payment is more than the amount due.', [chosen])
  return {
    kind: 'match',
    method: 'rule',
    expectedPaymentId: chosen.id,
    amount: due,
    followUp: 'overpayment',
    explanation: 'Reference matches; the payment is more than the amount due and the rest stays unallocated.',
  }
}
