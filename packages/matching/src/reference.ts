/** Upper case, letters and digits only: "inv-0042 " → "INV0042". */
export function normalizeReference(reference: string): string {
  return reference.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

// A run of known prefixes, only when digits follow ("INVOICE NO 42" → "42", "REFUND7" untouched).
const PREFIXES = /^(?:INVOICE|ACCOUNT|NUMBER|ORDER|ACCT|INV|ACC|REF|ORD|NO)+(?=[0-9])/

/**
 * The part of a reference people vary least: known prefixes are dropped when
 * digits follow them, then leading zeros. "INV 0042", "inv42", "Invoice #42"
 * and "0042" all give "42".
 */
export function referenceKey(reference: string): string {
  return normalizeReference(reference).replace(PREFIXES, '').replace(/^0+(?=[0-9])/, '')
}
