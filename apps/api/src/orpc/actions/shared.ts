import { schema, type Tx } from '@paysync/db'
import { MatchError, lockTransaction, readTransaction } from '@paysync/matching'
import { eq, sql } from 'drizzle-orm'
import { ActionError } from '../guarding/index.js'
import { iso, toExpectedPayment } from '../mappers.js'
import { listTransactions, paidByExpectedPayment, toBigInt } from '../queries.js'

const { allocation, expectedPayment, match, mpesaTransaction } = schema

export const kes = (minor: bigint) =>
  `KES ${(minor / 100n).toLocaleString('en-KE')}.${(minor % 100n).toString().padStart(2, '0')}`

/** Start of today in East Africa Time, for daily budgets. */
export const startOfTodayEat = () => sql`date_trunc('day', now() AT TIME ZONE 'Africa/Nairobi') AT TIME ZONE 'Africa/Nairobi'`

export function fromMatchError(error: unknown): never {
  if (!(error instanceof MatchError)) throw error
  switch (error.code) {
    case 'NOT_FOUND':
      throw new ActionError('NOT_FOUND', error.message)
    case 'STALE_STATE':
      throw new ActionError('STALE_STATE', error.message, { currentVersion: Number(error.details.currentVersion) })
    case 'NOT_VERIFIED':
    case 'EXPECTED_CLOSED':
    case 'ALREADY_UNMATCHED':
      throw new ActionError('INVALID_STATE', error.message, { status: error.details.status ?? error.code.toLowerCase() })
    case 'EXCEEDS_DUE':
    case 'EXCEEDS_AMOUNT':
      throw new ActionError('ALLOCATION_REJECTED', error.message, {
        expectedPaymentId: error.details.expectedPaymentId,
        unallocated: error.details.unallocatedMinor,
        due: error.details.dueMinor,
      })
  }
}

export async function matchOutput(tx: Tx, matchId: string) {
  const [m] = await tx.select().from(match).where(eq(match.id, matchId))
  if (!m) throw new ActionError('NOT_FOUND', 'match not found')
  const parts = await tx.select().from(allocation).where(eq(allocation.matchId, m.id))
  return {
    id: m.id,
    transactionId: m.transactionId,
    method: m.method,
    status: m.status,
    confidence: m.confidence === null ? null : Number(m.confidence),
    allocations: parts.map((a) => ({ expectedPaymentId: a.expectedPaymentId, amount: { minor: a.amount.toString(), currency: 'KES' as const } })),
    createdAt: iso(m.createdAt),
  }
}

export async function transactionOutput(tx: Tx, transactionId: string) {
  const [row] = await listTransactions(tx, eq(mpesaTransaction.id, transactionId), 1)
  if (!row) throw new ActionError('NOT_FOUND', 'transaction not found')
  return row
}

export async function expectedOutput(tx: Tx, id: string) {
  const paid = paidByExpectedPayment(tx)
  const [row] = await tx
    .select({ e: expectedPayment, paid: paid.total })
    .from(expectedPayment)
    .leftJoin(paid, eq(paid.expectedPaymentId, expectedPayment.id))
    .where(eq(expectedPayment.id, id))
  if (!row) throw new ActionError('NOT_FOUND', 'expected payment not found')
  return toExpectedPayment(row.e, toBigInt(row.paid))
}

/** The payment an action works on; locked (and version-checked) when it is about to change. */
export async function paymentFor(tx: Tx, transactionId: string, version: number, lock: boolean) {
  const payment = await (lock ? lockTransaction(tx, transactionId) : readTransaction(tx, transactionId))
  if (!payment) throw new ActionError('NOT_FOUND', 'transaction not found')
  if (lock && payment.version !== version) throw new ActionError('STALE_STATE', 'the transaction changed', { currentVersion: payment.version })
  return payment
}

/** What an agent action touches, as Jev sees it (§8.3): payer-typed text stays labelled untrusted. */
export async function paymentRecords(tx: Tx, transactionId: string) {
  const [row] = await tx
    .select({ receipt: mpesaTransaction.receiptNumber, reference: mpesaTransaction.billRefNumber })
    .from(mpesaTransaction)
    .where(eq(mpesaTransaction.id, transactionId))
  return row ? { payment: { receipt: row.receipt, untrusted_payment_reference: row.reference } } : null
}
