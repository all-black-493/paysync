import type { Sealer } from '@paysync/platform'

/** Personal fields inside callback bodies; sealed before the body is stored. */
const PII_FIELDS = new Set(['MSISDN', 'FirstName', 'MiddleName', 'LastName'])
/** `{ Name, Value }` items (STK) and `{ Key, Value }` result parameters whose value is personal. */
const PII_ITEMS = new Set(['PhoneNumber', 'DebitPartyName', 'CreditPartyName', 'CreditPartyPublicName', 'DebitPartyPublicName'])

interface SealedValue {
  readonly $sealed: string
}

function isSealed(value: unknown): value is SealedValue {
  return typeof value === 'object' && value !== null && '$sealed' in value && typeof value.$sealed === 'string'
}

/** Keeps the body's shape verbatim but replaces personal values with ciphertext. */
export function sealPayload(payload: unknown, pii: Sealer): unknown {
  if (Array.isArray(payload)) return payload.map((v) => sealPayload(v, pii))
  if (payload === null || typeof payload !== 'object') return payload
  const entries = Object.entries(payload)
  const isPiiItem = entries.some(([k, v]) => (k === 'Name' || k === 'Key') && typeof v === 'string' && PII_ITEMS.has(v))
  return Object.fromEntries(
    entries.map(([k, v]) => {
      const sensitive = PII_FIELDS.has(k) || (isPiiItem && k === 'Value')
      if (sensitive && v !== null && v !== undefined && v !== '') {
        return [k, { $sealed: pii.seal(String(v)).toString('base64') }]
      }
      return [k, sealPayload(v, pii)]
    }),
  )
}

/** Inverse of sealPayload (sealed numbers come back as strings). */
export function unsealPayload(payload: unknown, pii: Sealer): unknown {
  if (Array.isArray(payload)) return payload.map((v) => unsealPayload(v, pii))
  if (isSealed(payload)) return pii.open(Buffer.from(payload.$sealed, 'base64'))
  if (payload === null || typeof payload !== 'object') return payload
  return Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, unsealPayload(v, pii)]))
}
