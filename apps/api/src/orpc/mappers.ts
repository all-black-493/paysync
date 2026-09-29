import { toMoney } from '@paysync/contract'
import type { schema } from '@paysync/db'

type ExpectedRow = typeof schema.expectedPayment.$inferSelect
type ExceptionRow = typeof schema.exception.$inferSelect
type TransactionRow = typeof schema.mpesaTransaction.$inferSelect

export const iso = (d: Date): string => d.toISOString()

export { normalizeReference } from '@paysync/matching'

export function toExpectedPayment(row: ExpectedRow, paid: bigint) {
  return {
    id: row.id,
    reference: row.reference,
    description: row.description,
    amountDue: toMoney(row.amountDue),
    amountPaid: toMoney(paid),
    dueDate: row.dueDate,
    payerLabel: row.payerLabel,
    status: row.status,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    version: row.version,
  }
}

export function toException(row: ExceptionRow) {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    priority: row.priority,
    summary: row.summary,
    transactionId: row.transactionId,
    expectedPaymentId: row.expectedPaymentId,
    note: row.note,
    tags: row.tags,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    version: row.version,
  }
}

export function toTransaction(
  row: TransactionRow,
  shortcode: { id: string; code: string; kind: 'paybill' | 'till' },
  allocated: bigint,
  writtenOff = 0n,
) {
  return {
    id: row.id,
    receiptNumber: row.receiptNumber,
    amount: toMoney(row.amount),
    transactedAt: iso(row.transactedAt),
    status: row.status,
    verifiedAt: row.verifiedAt ? iso(row.verifiedAt) : null,
    source: row.source,
    billRefNumber: row.billRefNumber,
    shortcode,
    allocated: toMoney(allocated),
    writtenOff: toMoney(writtenOff),
    unallocated: toMoney(row.amount - allocated - writtenOff),
    version: row.version,
  }
}

export function pageOf<T extends { id: string }>(rows: T[], limit: number): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, limit)
  const last = items.at(-1)
  return { items, nextCursor: rows.length > limit && last ? last.id : null }
}
