import { schema, type Tx } from '@paysync/db'
import { and, eq, sql } from 'drizzle-orm'

const { allocation, match } = schema

/** Allocated totals per transaction, counting active matches only. */
export function allocatedByTransaction(tx: Tx) {
  return tx
    .select({
      transactionId: allocation.transactionId,
      total: sql<string>`sum(${allocation.amount})`.as('allocated_total'),
    })
    .from(allocation)
    .innerJoin(match, and(eq(match.id, allocation.matchId), eq(match.status, 'active')))
    .groupBy(allocation.transactionId)
    .as('allocated_by_transaction')
}

/** Paid totals per expected payment, counting active matches only. */
export function paidByExpectedPayment(tx: Tx) {
  return tx
    .select({
      expectedPaymentId: allocation.expectedPaymentId,
      total: sql<string>`sum(${allocation.amount})`.as('paid_total'),
    })
    .from(allocation)
    .innerJoin(match, and(eq(match.id, allocation.matchId), eq(match.status, 'active')))
    .groupBy(allocation.expectedPaymentId)
    .as('paid_by_expected_payment')
}

export const toBigInt = (value: string | null | undefined): bigint => (value ? BigInt(value) : 0n)
