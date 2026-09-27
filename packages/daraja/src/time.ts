import { DarajaParseError } from './money.js'

const STAMP = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/
/** Kenya has no daylight saving time. */
const EAT_OFFSET_MS = 3 * 60 * 60 * 1000

/** `YYYYMMDDHHmmss` in East Africa Time (string or JSON number) → UTC Date. */
export function parseDarajaTimestamp(value: string | number): Date {
  const text = String(value)
  const match = STAMP.exec(text)
  if (!match) throw new DarajaParseError(`not a Daraja timestamp: ${JSON.stringify(value)}`)
  const [, y, mo, d, h, mi, s] = match.map(Number)
  const utc = Date.UTC(y ?? 0, (mo ?? 1) - 1, d ?? 0, h ?? 0, mi ?? 0, s ?? 0) - EAT_OFFSET_MS
  const date = new Date(utc)
  if (formatDarajaTimestamp(date) !== text) throw new DarajaParseError(`impossible date: ${text}`)
  return date
}

export function formatDarajaTimestamp(date: Date): string {
  const eat = new Date(date.getTime() + EAT_OFFSET_MS)
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    String(eat.getUTCFullYear()) +
    pad(eat.getUTCMonth() + 1) +
    pad(eat.getUTCDate()) +
    pad(eat.getUTCHours()) +
    pad(eat.getUTCMinutes()) +
    pad(eat.getUTCSeconds())
  )
}
