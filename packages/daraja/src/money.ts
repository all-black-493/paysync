const DECIMAL = /^(\d{1,13})(?:\.(\d{1,2}))?$/

export class DarajaParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DarajaParseError'
  }
}

/**
 * Daraja amounts arrive as strings ("5.00") or JSON numbers (1.0). Converted
 * to integer minor units without going through floating point arithmetic.
 */
export function parseAmount(value: string | number): bigint {
  const text = typeof value === 'number' ? numberToPlainString(value) : value.trim()
  const match = DECIMAL.exec(text)
  if (!match) throw new DarajaParseError(`not a valid amount: ${JSON.stringify(value)}`)
  const [, whole = '0', cents = ''] = match
  return BigInt(whole) * 100n + BigInt(cents.padEnd(2, '0'))
}

function numberToPlainString(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new DarajaParseError(`not a valid amount: ${value}`)
  // toFixed(2) is exact for any value Daraja can send (at most two decimals, < 1e13).
  const fixed = value.toFixed(2)
  if (Math.abs(Number(fixed) - value) > 1e-9) throw new DarajaParseError(`amount has more than two decimals: ${value}`)
  return fixed
}

/** Daraja requests take whole shillings. */
export function toWholeShillings(minor: bigint): number {
  if (minor <= 0n || minor % 100n !== 0n) throw new DarajaParseError('Daraja requests need a positive whole-shilling amount')
  return Number(minor / 100n)
}
