import { schema, type Tx } from '@paysync/db'
import { and, desc, eq, sql, type SQL } from 'drizzle-orm'
import { toTransaction } from './mappers.js'

const { allocation, match, mpesaTransaction, shortcode, varianceWriteOff } = schema

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

/** Written-off totals per transaction. */
export function writtenOffByTransaction(tx: Tx) {
  return tx
    .select({
      transactionId: varianceWriteOff.transactionId,
      total: sql<string>`sum(${varianceWriteOff.amount})`.as('written_off_total'),
    })
    .from(varianceWriteOff)
    .groupBy(varianceWriteOff.transactionId)
    .as('written_off_by_transaction')
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

export async function listTransactions(tx: Tx, where: SQL | undefined, limit: number) {
  const allocated = allocatedByTransaction(tx)
  const writtenOff = writtenOffByTransaction(tx)
  const rows = await tx
    .select({
      t: mpesaTransaction,
      s: { id: shortcode.id, code: shortcode.code, kind: shortcode.kind },
      allocated: allocated.total,
      writtenOff: writtenOff.total,
    })
    .from(mpesaTransaction)
    .innerJoin(shortcode, eq(shortcode.id, mpesaTransaction.shortcodeId))
    .leftJoin(allocated, eq(allocated.transactionId, mpesaTransaction.id))
    .leftJoin(writtenOff, eq(writtenOff.transactionId, mpesaTransaction.id))
    .where(where)
    .orderBy(desc(mpesaTransaction.id))
    .limit(limit)
  return rows.map((r) => toTransaction(r.t, r.s, toBigInt(r.allocated), toBigInt(r.writtenOff)))
}
