import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { AllocationError, planAllocation } from './allocation.js'
import { journalProblems, type JournalLine } from './ledger.js'

const MAX_MINOR = 10n ** 12n
const nonZeroAmount = fc.bigInt({ min: -MAX_MINOR, max: MAX_MINOR }).filter((a) => a !== 0n)
const account = fc.constantFrom('cash', 'receivable', 'suspense', 'income')

/** Any lines plus one balancing line; drops the case where the balancing line would be zero. */
const balancedJournal = fc
  .array(fc.record({ accountId: account, amount: nonZeroAmount }), { minLength: 1, maxLength: 12 })
  .map((lines): JournalLine[] => [
    ...lines,
    { accountId: 'suspense', amount: -lines.reduce((sum, l) => sum + l.amount, 0n) },
  ])
  .filter((lines) => lines.every((l) => l.amount !== 0n))

describe('journal balance (property)', () => {
  it('accepts every balanced journal', () => {
    fc.assert(
      fc.property(balancedJournal, (lines) => {
        expect(journalProblems(lines)).toEqual([])
      }),
    )
  })

  it('rejects a balanced journal after any single line changes', () => {
    fc.assert(
      fc.property(balancedJournal, fc.nat(), nonZeroAmount, (lines, index, delta) => {
        const i = index % lines.length
        const line = lines[i]
        fc.pre(line !== undefined && line.amount + delta !== 0n)
        const changed = lines.map((l, j) => (j === i ? { ...l, amount: l.amount + delta } : l))
        expect(journalProblems(changed)).toContainEqual(expect.stringMatching(/sum to/))
      }),
    )
  })

  it('rejects journals with fewer than two lines or a zero line', () => {
    fc.assert(
      fc.property(nonZeroAmount, (amount) => {
        expect(journalProblems([{ accountId: 'cash', amount }]).length).toBeGreaterThan(0)
        expect(journalProblems([{ accountId: 'cash', amount: 0n }, { accountId: 'x', amount: 0n }])).toContainEqual(
          expect.stringMatching(/non-zero/),
        )
      }),
    )
  })
})

describe('allocation (property)', () => {
  const positive = fc.bigInt({ min: 1n, max: MAX_MINOR })

  it('never allocates more than the transaction amount, and the remainder is explicit', () => {
    fc.assert(
      fc.property(positive, fc.array(fc.array(positive, { minLength: 1, maxLength: 4 }), { maxLength: 20 }), (amount, requests) => {
        const accepted: bigint[] = []
        for (const request of requests) {
          const before = accepted.reduce((s, a) => s + a, 0n)
          const wanted = request.reduce((s, a) => s + a, 0n)
          try {
            const plan = planAllocation(amount, accepted, request)
            accepted.push(...request)
            expect(plan.allocated).toBe(before + wanted)
            expect(plan.unallocated).toBe(amount - plan.allocated)
          } catch (error) {
            expect(error).toBeInstanceOf(AllocationError)
            expect(before + wanted).toBeGreaterThan(amount)
          }
          const total = accepted.reduce((s, a) => s + a, 0n)
          expect(total).toBeLessThanOrEqual(amount)
        }
      }),
    )
  })

  it('rejects non-positive amounts', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -MAX_MINOR, max: 0n }), (bad) => {
        expect(() => planAllocation(100n, [], [bad])).toThrow(AllocationError)
        expect(() => planAllocation(bad, [], [])).toThrow(AllocationError)
      }),
    )
  })
})
