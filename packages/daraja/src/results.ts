import { DarajaParseError, parseAmount } from './money.js'
import type { DarajaResult, PullRecord } from './schemas.js'
import { parseDarajaTimestamp } from './time.js'
import type { NormalizedPayment } from './normalize.js'

export interface ResultBase {
  readonly succeeded: boolean
  readonly resultCode: string
  readonly resultDesc: string
  readonly conversationId: string
  readonly originatorConversationId: string
}

export function resultBase(result: DarajaResult): ResultBase {
  const r = result.Result
  return {
    succeeded: r.ResultCode === '0',
    resultCode: r.ResultCode,
    resultDesc: r.ResultDesc,
    conversationId: r.ConversationID,
    originatorConversationId: r.OriginatorConversationID,
  }
}

/** First value per key; the documented sample repeats `DebitPartyName` where the second is the credit party. */
export function resultParameters(result: DarajaResult): Map<string, string> {
  const raw = result.Result.ResultParameters?.ResultParameter
  const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]
  const params = new Map<string, string>()
  for (const p of list) {
    if (p.Value !== undefined && !params.has(p.Key)) params.set(p.Key, String(p.Value))
  }
  return params
}

export function optionalTimestamp(value: string | undefined): Date | null {
  if (value === undefined || value === '') return null
  try {
    return parseDarajaTimestamp(value)
  } catch {
    return null
  }
}

export interface TransactionStatusResult extends ResultBase {
  readonly receiptNumber: string | null
  readonly amountMinor: bigint | null
  /** M-Pesa's own status, e.g. "Completed". */
  readonly transactionStatus: string | null
  /** "<shortcode> - <name>" for C2B payments to us. */
  readonly creditParty: string | null
  readonly finalisedAt: Date | null
}

export function normalizeTransactionStatusResult(result: DarajaResult): TransactionStatusResult {
  const params = resultParameters(result)
  const amount = params.get('Amount')
  return {
    ...resultBase(result),
    receiptNumber: params.get('ReceiptNo') ?? null,
    amountMinor: amount === undefined ? null : parseAmount(amount),
    transactionStatus: params.get('TransactionStatus') ?? null,
    creditParty: params.get('CreditPartyName') ?? null,
    finalisedAt: optionalTimestamp(params.get('FinalisedTime')),
  }
}

export interface BalanceAccount {
  readonly name: string
  readonly currency: string
  /** Signed minor units. */
  readonly available: bigint
  readonly uncleared: bigint
  readonly reserved: bigint
}

function signedAmount(text: string): bigint {
  const trimmed = text.trim()
  return trimmed.startsWith('-') ? -parseAmount(trimmed.slice(1)) : parseAmount(trimmed)
}

/** `Name|KES|available|uncleared|reserved|unreserved` accounts joined by `&`. */
export function parseAccountBalance(value: string): BalanceAccount[] {
  return value
    .split('&')
    .filter((part) => part.trim() !== '')
    .map((part) => {
      const [name, currency, available, uncleared, reserved] = part.split('|')
      if (!name || !currency || available === undefined || uncleared === undefined || reserved === undefined) {
        throw new DarajaParseError(`unexpected account balance entry: ${JSON.stringify(part)}`)
      }
      return {
        name: name.trim(),
        currency: currency.trim(),
        available: signedAmount(available),
        uncleared: signedAmount(uncleared),
        reserved: signedAmount(reserved),
      }
    })
}

export interface AccountBalanceResult extends ResultBase {
  readonly accounts: readonly BalanceAccount[]
  readonly completedAt: Date | null
}

export function normalizeAccountBalanceResult(result: DarajaResult): AccountBalanceResult {
  const params = resultParameters(result)
  const balance = params.get('AccountBalance')
  return {
    ...resultBase(result),
    accounts: balance === undefined ? [] : parseAccountBalance(balance),
    completedAt: optionalTimestamp(params.get('BOCompletedTime')),
  }
}

const EAT_LOCAL = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/

/** ISO timestamps with a zone are taken as given; zone-less ones are EAT. */
export function parsePullDate(value: string): Date {
  const local = EAT_LOCAL.exec(value.trim())
  if (local) {
    const [, y, mo, d, h, mi, s] = local
    const stamp = `${y}${mo}${d}${(h ?? '').padStart(2, '0')}${mi}${s ?? '00'}`
    return parseDarajaTimestamp(stamp)
  }
  const date = new Date(value)
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(value.trim()) || Number.isNaN(date.getTime())) {
    throw new DarajaParseError(`not a Pull Transactions date: ${JSON.stringify(value)}`)
  }
  return date
}

/** Pull Transactions takes `YYYY-MM-DD HH:mm:ss` in EAT. */
export function formatPullDate(date: Date): string {
  const eat = new Date(date.getTime() + 3 * 60 * 60 * 1000)
  return eat.toISOString().slice(0, 19).replace('T', ' ')
}

export function normalizePullRecord(record: PullRecord, shortcode: string): NormalizedPayment {
  if (!/^[A-Z0-9]{10}$/.test(record.transactionId)) {
    throw new DarajaParseError(`unexpected receipt number format: ${JSON.stringify(record.transactionId)}`)
  }
  return {
    receiptNumber: record.transactionId,
    amountMinor: parseAmount(record.amount),
    transactedAt: parsePullDate(record.trxDate),
    billRefNumber: record.billreference === '' ? null : record.billreference,
    payerName: record.sender ?? null,
    msisdn: record.msisdn ?? null,
    shortcode,
  }
}
