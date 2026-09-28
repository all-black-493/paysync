import { enqueueJob, postReceipt, raiseException, schema, type Tx } from '@paysync/db'
import { and, eq, sql } from 'drizzle-orm'

const { mpesaTransaction } = schema

export type VerificationMethod = (typeof schema.VERIFICATION_METHODS)[number]
type TransactionRow = typeof mpesaTransaction.$inferSelect

async function lockPending(tx: Tx, transactionId: string): Promise<TransactionRow | null> {
  const [row] = await tx.select().from(mpesaTransaction).where(eq(mpesaTransaction.id, transactionId)).for('update')
  return row?.status === 'pending_verification' ? row : null
}

/**
 * The money gate: the only path from pending_verification to verified, and
 * the only place a receipt reaches the ledger. Returns false if the
 * transaction was no longer pending.
 */
export async function markVerified(tx: Tx, transactionId: string, method: VerificationMethod): Promise<boolean> {
  const row = await lockPending(tx, transactionId)
  if (!row) return false
  await tx
    .update(mpesaTransaction)
    .set({ status: 'verified', verifiedAt: sql`now()`, verificationMethod: method, version: row.version + 1 })
    .where(and(eq(mpesaTransaction.id, row.id), eq(mpesaTransaction.status, 'pending_verification')))
  await postReceipt(tx, {
    orgId: row.orgId,
    transactionId: row.id,
    receiptNumber: row.receiptNumber,
    amount: row.amount,
    createdBy: `verification:${method}`,
  })
  await enqueueJob(tx, 'match_transaction', { orgId: row.orgId, transactionId: row.id }, { jobKey: `match:${row.id}` })
  return true
}

/** Safaricom contradicts the payment: no ledger credit, and a human is asked to look. */
export async function failVerification(
  tx: Tx,
  transactionId: string,
  reason: string,
  details: Record<string, unknown>,
): Promise<boolean> {
  const row = await lockPending(tx, transactionId)
  if (!row) return false
  await tx
    .update(mpesaTransaction)
    .set({ status: 'verification_failed', version: row.version + 1 })
    .where(and(eq(mpesaTransaction.id, row.id), eq(mpesaTransaction.status, 'pending_verification')))
  await raiseException(tx, {
    orgId: row.orgId,
    kind: 'verification_failed',
    priority: 'high',
    summary: `Payment ${row.receiptNumber} failed verification: ${reason}`,
    transactionId: row.id,
    details,
    dedupeKey: `verification_failed:${row.id}`,
  })
  return true
}
