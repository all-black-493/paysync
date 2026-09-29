import type { TransactionStatusResult } from '@paysync/daraja'
import { schema, type Tx } from '@paysync/db'
import { eq } from 'drizzle-orm'
import type { WorkerDeps } from '../deps.js'
import { failVerification, markVerified } from '../verification.js'

const { mpesaTransaction, shortcode } = schema

type RequestRow = typeof schema.darajaRequest.$inferSelect

function mismatches(result: TransactionStatusResult, expected: { receipt: string; amount: bigint; shortcode: string }): string[] {
  const problems: string[] = []
  if (result.receiptNumber !== expected.receipt) problems.push(`receipt ${String(result.receiptNumber)} ≠ ${expected.receipt}`)
  if (result.amountMinor !== expected.amount) problems.push(`amount ${String(result.amountMinor)} ≠ ${expected.amount}`)
  if (result.transactionStatus !== 'Completed') problems.push(`M-Pesa status is ${String(result.transactionStatus)}`)
  if (result.creditParty !== null && !result.creditParty.startsWith(`${expected.shortcode} `)) {
    problems.push('credited to a different shortcode')
  }
  return problems
}

/** A Transaction Status result verifies the payment only when everything agrees. */
export async function applyTransactionStatus(deps: WorkerDeps, tx: Tx, request: RequestRow, result: TransactionStatusResult) {
  if (!request.transactionId) return
  // Any other code (e.g. a rejected initiator credential) says nothing about the payment: stay pending, fail closed.
  if (!result.succeeded) {
    deps.logger.warn({ requestId: request.id, resultCode: result.resultCode, resultDesc: result.resultDesc }, 'Transaction Status did not succeed')
    return
  }
  const [row] = await tx
    .select({ receipt: mpesaTransaction.receiptNumber, amount: mpesaTransaction.amount, code: shortcode.code })
    .from(mpesaTransaction)
    .innerJoin(shortcode, eq(shortcode.id, mpesaTransaction.shortcodeId))
    .where(eq(mpesaTransaction.id, request.transactionId))
  if (!row) return
  const problems = mismatches(result, { receipt: row.receipt, amount: row.amount, shortcode: row.code })
  if (problems.length === 0) {
    await markVerified(tx, request.transactionId, 'transaction_status')
    return
  }
  await failVerification(tx, request.transactionId, 'Transaction Status disagrees with the callback', {
    method: 'transaction_status',
    problems,
    conversationId: result.conversationId,
  })
}
