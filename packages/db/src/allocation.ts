import { and, eq } from 'drizzle-orm'
import { allocation, match, mpesaTransaction } from './schema/core.js'
import type { Tx } from './tenancy.js'

export class AllocationError extends Error {
  readonly code: 'EXCEEDS_AMOUNT' | 'INVALID_AMOUNT' | 'NOT_FOUND'

  constructor(code: AllocationError['code'], message: string) {
    super(message)
    this.name = 'AllocationError'
    this.code = code
  }
}

export interface AllocationPlan {
  readonly allocated: bigint
  readonly unallocated: bigint
}

/** Pure allocation math: never exceeds the transaction amount, remainder stays explicit. */
export function planAllocation(amount: bigint, existing: readonly bigint[], requested: readonly bigint[]): AllocationPlan {
  if (amount <= 0n) throw new AllocationError('INVALID_AMOUNT', 'transaction amount must be positive')
  if ([...existing, ...requested].some((a) => a <= 0n)) {
    throw new AllocationError('INVALID_AMOUNT', 'allocation amounts must be positive')
  }
  const allocated = [...existing, ...requested].reduce((sum, a) => sum + a, 0n)
  if (allocated > amount) {
    throw new AllocationError('EXCEEDS_AMOUNT', `allocations total ${allocated}, above the transaction amount ${amount}`)
  }
  return { allocated, unallocated: amount - allocated }
}

export interface AllocateInput {
  readonly orgId: string
  readonly transactionId: string
  readonly matchId: string
  readonly parts: ReadonlyArray<{ readonly expectedPaymentId: string; readonly amount: bigint }>
}

/**
 * Locks the transaction row, checks the plan in code, then inserts. The
 * database re-checks the total at commit.
 */
export async function allocate(tx: Tx, input: AllocateInput): Promise<AllocationPlan> {
  const [txRow] = await tx
    .select({ amount: mpesaTransaction.amount })
    .from(mpesaTransaction)
    .where(eq(mpesaTransaction.id, input.transactionId))
    .for('update')
  if (!txRow) throw new AllocationError('NOT_FOUND', `transaction ${input.transactionId} not found`)

  const existing = await tx
    .select({ amount: allocation.amount })
    .from(allocation)
    .innerJoin(match, eq(match.id, allocation.matchId))
    .where(and(eq(allocation.transactionId, input.transactionId), eq(match.status, 'active')))

  const plan = planAllocation(
    txRow.amount,
    existing.map((e) => e.amount),
    input.parts.map((p) => p.amount),
  )
  await tx.insert(allocation).values(
    input.parts.map((p) => ({
      orgId: input.orgId,
      matchId: input.matchId,
      transactionId: input.transactionId,
      expectedPaymentId: p.expectedPaymentId,
      amount: p.amount,
    })),
  )
  return plan
}
