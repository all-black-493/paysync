import type { CandidateChoice } from '@paysync/decisions'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { DEFAULT_MATCH_POLICY, decide, exception, type Candidate, type PaymentFacts } from './decide.js'
import { afterJev, jevCandidates, needsJev } from './jev-tier.js'

const at = new Date('2026-09-28T09:00:00Z')
const payment = (reference: string | null, amount: bigint, allocated = 0n): PaymentFacts => ({ reference, amount, allocated, transactedAt: at })
const candidate = (id: string, reference: string, amountDue: bigint, extra: Partial<Candidate> = {}): Candidate => ({
  id,
  reference,
  amountDue,
  paid: 0n,
  dueDate: '2026-10-01',
  status: 'open',
  ...extra,
})
const choice = (candidateId: string | null, confidence: number, injection = 0.01): CandidateChoice => ({
  candidateId,
  confidence,
  injection,
  probabilities: candidateId ? { [candidateId]: confidence, none_of_these: 1 - confidence } : { none_of_these: confidence },
  model: 'fake-jev',
  latencyMs: 12,
})

const rent = candidate('a2', 'UNIT-A2-OCT', 150000n)
const pool = [rent, candidate('b7', 'UNIT-B7-OCT', 150000n)]
const pay = payment('house a2 october', 150000n)
const fallback = exception('no_match', 'No open expected payment has this reference.')

describe('when Jev is asked', () => {
  it('only for no match or several candidates, and only with a reference to read', () => {
    expect(needsJev(pay, decide(pay, pool))).toBe(true)
    expect(needsJev(pay, exception('low_confidence', 'x', pool))).toBe(true)
    for (const reason of ['duplicate', 'partial_payment', 'overpayment'] as const) expect(needsJev(pay, exception(reason, 'x', pool))).toBe(false)
    expect(needsJev(payment('  ', 150000n), exception('no_match', 'x'))).toBe(false)
    expect(needsJev(pay, decide(payment('UNIT-A2-OCT', 150000n), pool))).toBe(false)
  })

  it('with open candidates in the date window, closest amount then date first, capped', () => {
    const many = [
      candidate('far-amount', 'X1', 900000n),
      candidate('closed', 'X2', 150000n, { status: 'paid' }),
      candidate('void', 'X3', 150000n, { status: 'void' }),
      candidate('old', 'X4', 150000n, { dueDate: '2025-01-01' }),
      candidate('settled', 'X5', 150000n, { paid: 150000n, status: 'partially_paid' }),
      candidate('same-later', 'X6', 150000n, { dueDate: '2026-11-20' }),
      candidate('same-sooner', 'X7', 150000n, { dueDate: '2026-09-30' }),
      candidate('close-amount', 'X8', 140000n),
    ]
    expect(jevCandidates(pay, many, DEFAULT_MATCH_POLICY).map((c) => c.id)).toEqual(['same-sooner', 'same-later', 'close-amount', 'far-amount'])
    const capped = { ...DEFAULT_MATCH_POLICY, jev: { ...DEFAULT_MATCH_POLICY.jev, maxCandidates: 2 } }
    expect(jevCandidates(pay, many, capped)).toHaveLength(2)
  })
})

describe('after Jev answered (§7.3)', () => {
  it('auto-matches at 0.90 and above when the amount is what is due, keeping the evidence', () => {
    for (const confidence of [0.9, 0.97]) {
      const d = afterJev(pay, pool, choice('a2', confidence), fallback, DEFAULT_MATCH_POLICY)
      expect(d).toMatchObject({ kind: 'match', method: 'jev', expectedPaymentId: 'a2', amount: 150000n, evidence: { confidence, candidateId: 'a2' } })
    }
  })

  it('suggests to a person between 0.50 and 0.90', () => {
    for (const confidence of [0.5, 0.89]) {
      const d = afterJev(pay, pool, choice('a2', confidence), fallback, DEFAULT_MATCH_POLICY)
      expect(d).toMatchObject({ kind: 'exception', exception: 'low_confidence', candidateIds: ['a2'], evidence: { confidence } })
    }
  })

  it('keeps the exception below 0.50, for none of these, or when the reference reads like instructions', () => {
    const cases = [choice('a2', 0.49), choice(null, 0.95), choice('a2', 0.99, 0.21)]
    for (const c of cases) {
      const d = afterJev(pay, pool, c, fallback, DEFAULT_MATCH_POLICY)
      expect(d).toMatchObject({ kind: 'exception', exception: 'no_match', candidateIds: [], evidence: { injection: c.injection } })
    }
    expect(afterJev(pay, pool, choice('a2', 0.99, 0.2), fallback, DEFAULT_MATCH_POLICY).kind).toBe('match')
  })

  it('never matches a candidate that is gone, closed or outside the window, however sure', () => {
    for (const fresh of [[pool[1] ?? rent], [{ ...rent, status: 'paid' as const }], [{ ...rent, dueDate: '2025-01-01' }]]) {
      expect(afterJev(pay, fresh, choice('a2', 0.99), fallback, DEFAULT_MATCH_POLICY)).toMatchObject({ kind: 'exception', exception: 'no_match' })
    }
  })

  it('partial and over payments still wait for a person (owner decision)', () => {
    expect(afterJev(payment('a2', 100000n), pool, choice('a2', 0.99), fallback, DEFAULT_MATCH_POLICY)).toMatchObject({
      kind: 'exception',
      exception: 'partial_payment',
      candidateIds: ['a2'],
    })
    expect(afterJev(payment('a2', 200000n), pool, choice('a2', 0.99), fallback, DEFAULT_MATCH_POLICY)).toMatchObject({
      kind: 'exception',
      exception: 'overpayment',
    })
  })

  it('never allocates more than is available or due, and only to a candidate it was offered (property)', () => {
    const arbitraryCandidate = fc.record({
      id: fc.constantFrom('c1', 'c2', 'c3'),
      amountDue: fc.bigInt({ min: 1n, max: 1_000_000n }),
      paid: fc.bigInt({ min: 0n, max: 1_000_000n }),
      status: fc.constantFrom('open', 'partially_paid', 'paid', 'void'),
    })
    fc.assert(
      fc.property(
        fc.array(arbitraryCandidate, { maxLength: 3 }),
        fc.bigInt({ min: 1n, max: 1_000_000n }),
        fc.bigInt({ min: 0n, max: 1_000_000n }),
        fc.constantFrom('c1', 'c2', 'c3', null),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (raw, amount, allocated, chosen, confidence, injection) => {
          const offered = raw.map((r) => candidate(r.id, r.id, r.amountDue, { paid: r.paid, status: r.status }))
          const d = afterJev(payment('x', amount, allocated), offered, choice(chosen, confidence, injection), fallback, DEFAULT_MATCH_POLICY)
          if (d.kind !== 'match') return
          const target = offered.find((c) => c.id === d.expectedPaymentId)
          expect(target).toBeDefined()
          expect(confidence).toBeGreaterThanOrEqual(0.9)
          expect(injection).toBeLessThanOrEqual(0.2)
          expect(d.amount).toBeLessThanOrEqual(amount - allocated)
          expect(d.amount).toBeLessThanOrEqual((target?.amountDue ?? 0n) - (target?.paid ?? 0n))
        },
      ),
      { numRuns: 2000 },
    )
  })
})
