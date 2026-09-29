import type { ReversalResult } from '@paysync/daraja'
import { RECEIPT_ACCOUNTS, ensureAccount, postJournal, raiseException, schema, type Tx } from '@paysync/db'
import { eq } from 'drizzle-orm'
import type { WorkerDeps } from '../deps.js'

const { mpesaTransaction } = schema

type RequestRow = typeof schema.darajaRequest.$inferSelect

async function reversalFailed(tx: Tx, request: RequestRow, receipt: string, summary: string, details: Record<string, unknown>) {
  await raiseException(tx, {
    orgId: request.orgId,
    kind: 'reversal_failed',
    priority: 'high',
    summary: `Reversal of payment ${receipt}: ${summary}`,
    transactionId: request.transactionId,
    details,
    dedupeKey: `reversal_failed:${request.id}`,
  })
}

/**
 * A payment becomes reversed only when Safaricom confirms the reversal of
 * that receipt for that amount. Anything else is a high-priority exception:
 * money may or may not have moved, so a person checks before acting again.
 */
export async function applyReversal(deps: WorkerDeps, tx: Tx, request: RequestRow, result: ReversalResult) {
  if (!request.transactionId) return
  const [row] = await tx.select().from(mpesaTransaction).where(eq(mpesaTransaction.id, request.transactionId)).for('update')
  if (!row) return
  if (!result.succeeded) {
    await reversalFailed(tx, request, row.receiptNumber, `M-Pesa refused it (${result.resultCode}: ${result.resultDesc})`, { resultCode: result.resultCode })
    return
  }
  const problems: string[] = []
  if (result.originalReceiptNumber !== null && result.originalReceiptNumber !== row.receiptNumber) problems.push('a different receipt was reversed')
  if (result.amountMinor !== null && result.amountMinor !== row.amount) problems.push('a different amount was reversed')
  if (problems.length > 0) {
    await reversalFailed(tx, request, row.receiptNumber, `the result disagrees with the request (${problems.join('; ')})`, {
      reversedReceipt: result.originalReceiptNumber,
      reversedMinor: result.amountMinor?.toString() ?? null,
    })
    return
  }
  if (row.status !== 'verified') return

  await tx.update(mpesaTransaction).set({ status: 'reversed', version: row.version + 1 }).where(eq(mpesaTransaction.id, row.id))
  // The money went back to the payer: unallocated receipts and the float both go down.
  const suspense = await ensureAccount(tx, row.orgId, RECEIPT_ACCOUNTS.suspense)
  const float = await ensureAccount(tx, row.orgId, RECEIPT_ACCOUNTS.float)
  await postJournal(tx, {
    orgId: row.orgId,
    kind: 'reversal',
    description: `M-Pesa reversal of ${row.receiptNumber} (${result.reversalReceiptNumber ?? 'no receipt'})`,
    idempotencyKey: `reversal:${row.id}`,
    transactionId: row.id,
    createdBy: 'daraja:reversal',
    lines: [
      { accountId: suspense, amount: row.amount },
      { accountId: float, amount: -row.amount },
    ],
  })
  deps.logger.info({ transactionId: row.id, reversalReceipt: result.reversalReceiptNumber }, 'payment reversed')
}

/** No answer from M-Pesa in time: the outcome is unknown, so a person checks. */
export async function applyReversalTimeout(tx: Tx, request: RequestRow) {
  if (!request.transactionId) return
  const [row] = await tx.select({ receipt: mpesaTransaction.receiptNumber }).from(mpesaTransaction).where(eq(mpesaTransaction.id, request.transactionId))
  await reversalFailed(tx, request, row?.receipt ?? 'unknown', 'M-Pesa timed out; check the statement before requesting it again', {
    conversationId: request.conversationId,
  })
}
