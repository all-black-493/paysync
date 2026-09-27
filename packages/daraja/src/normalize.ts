import { DarajaParseError, parseAmount } from './money.js'
import type { C2BNotification, StkCallback } from './schemas.js'
import { parseDarajaTimestamp } from './time.js'

/** Our own outcome for M-Pesa Express, whatever the product-specific code. */
export type StkOutcome = 'succeeded' | 'pending' | 'cancelled' | 'failed'

const STK_CANCELLED = new Set(['1032'])
/** Undocumented; observed in the sandbox while a push is still open. */
const STK_PENDING = new Set(['4999'])

export function stkOutcome(resultCode: string): StkOutcome {
  if (resultCode === '0') return 'succeeded'
  if (STK_PENDING.has(resultCode)) return 'pending'
  if (STK_CANCELLED.has(resultCode)) return 'cancelled'
  return 'failed'
}

export interface NormalizedPayment {
  readonly receiptNumber: string
  readonly amountMinor: bigint
  readonly transactedAt: Date
  /** Untrusted text typed by the payer. */
  readonly billRefNumber: string | null
  readonly payerName: string | null
  /** As delivered; Safaricom now masks it (e.g. "2547 ***** 126"). */
  readonly msisdn: string | null
  readonly shortcode: string | null
}

export type NormalizedStkCallback =
  | {
      readonly outcome: 'succeeded'
      readonly checkoutRequestId: string
      readonly merchantRequestId: string
      readonly resultCode: string
      readonly resultDesc: string
      readonly payment: NormalizedPayment
    }
  | {
      readonly outcome: Exclude<StkOutcome, 'succeeded'>
      readonly checkoutRequestId: string
      readonly merchantRequestId: string
      readonly resultCode: string
      readonly resultDesc: string
    }

export function normalizeStkCallback(callback: StkCallback): NormalizedStkCallback {
  const cb = callback.Body.stkCallback
  const base = {
    checkoutRequestId: cb.CheckoutRequestID,
    merchantRequestId: cb.MerchantRequestID,
    resultCode: cb.ResultCode,
    resultDesc: cb.ResultDesc,
  }
  const outcome = stkOutcome(cb.ResultCode)
  if (outcome !== 'succeeded') return { ...base, outcome }

  const items = new Map((cb.CallbackMetadata?.Item ?? []).map((i) => [i.Name, i.Value]))
  const receipt = items.get('MpesaReceiptNumber')
  const amount = items.get('Amount')
  const date = items.get('TransactionDate')
  if (typeof receipt !== 'string' || amount === undefined || date === undefined) {
    throw new DarajaParseError('successful STK callback without receipt, amount or date')
  }
  const phone = items.get('PhoneNumber')
  return {
    ...base,
    outcome,
    payment: {
      receiptNumber: receipt,
      amountMinor: parseAmount(amount),
      transactedAt: parseDarajaTimestamp(date),
      billRefNumber: null,
      payerName: null,
      msisdn: phone === undefined ? null : String(phone),
      shortcode: null,
    },
  }
}

export function normalizeC2B(notification: C2BNotification): NormalizedPayment {
  const name = [notification.FirstName, notification.MiddleName, notification.LastName]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ')
  return {
    receiptNumber: notification.TransID,
    amountMinor: parseAmount(notification.TransAmount),
    transactedAt: parseDarajaTimestamp(notification.TransTime),
    billRefNumber: notification.BillRefNumber === '' ? null : notification.BillRefNumber,
    payerName: name === '' ? null : name,
    msisdn: notification.MSISDN ?? null,
    shortcode: notification.BusinessShortCode,
  }
}
