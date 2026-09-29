import { parseAmount } from './money.js'
import { optionalTimestamp, resultBase, resultParameters, type ResultBase } from './results.js'
import type { DarajaResult } from './schemas.js'

export interface ReversalResult extends ResultBase {
  /** The receipt that was reversed. */
  readonly originalReceiptNumber: string | null
  /** The reversal's own M-Pesa receipt. */
  readonly reversalReceiptNumber: string | null
  readonly amountMinor: bigint | null
  readonly completedAt: Date | null
}

/** Reversal Result URL body (documented codes: 0, R000001 already reversed, R000002 invalid receipt, 2001, 21, ...). */
export function normalizeReversalResult(result: DarajaResult): ReversalResult {
  const params = resultParameters(result)
  const amount = params.get('Amount')
  return {
    ...resultBase(result),
    originalReceiptNumber: params.get('OriginalTransactionID') ?? null,
    reversalReceiptNumber: result.Result.TransactionID ?? null,
    amountMinor: amount === undefined ? null : parseAmount(amount),
    completedAt: optionalTimestamp(params.get('TransCompletedTime')),
  }
}
