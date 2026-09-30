const NAIROBI = 'Africa/Nairobi'

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** "1,250.50" from minor units, without floats. */
export function formatAmount(money: { minor: string }): string {
  const minor = BigInt(money.minor)
  const sign = minor < 0n ? '-' : ''
  const abs = minor < 0n ? -minor : minor
  return `${sign}${groupThousands((abs / 100n).toString())}.${(abs % 100n).toString().padStart(2, '0')}`
}

export function formatKes(money: { minor: string }): string {
  return `KES ${formatAmount(money)}`
}

/** User-entered shillings ("1,250.50") to integer minor units, without floats. */
export function parseKes(input: string): string | null {
  const match = /^\s*(\d{1,13})(?:\.(\d{1,2}))?\s*$/.exec(input.replace(/,/g, ''))
  if (!match) return null
  const [, whole = '0', cents = ''] = match
  return (BigInt(whole) * 100n + BigInt(cents.padEnd(2, '0'))).toString()
}

export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium', timeStyle: 'short', timeZone: NAIROBI }).format(new Date(iso))
}

/** "25 Sept, 17:31", with the year only when it is not this year. */
export function formatShortDateTime(iso: string): string {
  const date = new Date(iso)
  const year = new Intl.DateTimeFormat('en-KE', { year: 'numeric', timeZone: NAIROBI })
  const sameYear = year.format(date) === year.format(new Date())
  return new Intl.DateTimeFormat('en-KE', {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: NAIROBI,
  }).format(date)
}

const UNITS: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
]

export function formatRelative(iso: string, now: number = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000)
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit)
  }
  return 'just now'
}

export function todayInNairobi(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: NAIROBI }).format(new Date())
}

export function newIdempotencyKey(action: string): string {
  return `${action}-${crypto.randomUUID()}`
}

export function field(form: FormData, name: string): string {
  const value = form.get(name)
  return typeof value === 'string' ? value : ''
}
