export function formatKes(money: { minor: string }): string {
  const minor = BigInt(money.minor)
  const whole = (minor / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const cents = (minor % 100n).toString().padStart(2, '0')
  return `KES ${whole}.${cents}`
}

/** User-entered shillings ("1,250.50") to integer minor units, without floats. */
export function parseKes(input: string): string | null {
  const match = /^\s*(\d{1,13})(?:\.(\d{1,2}))?\s*$/.exec(input.replace(/,/g, ''))
  if (!match) return null
  const [, whole = '0', cents = ''] = match
  return (BigInt(whole) * 100n + BigInt(cents.padEnd(2, '0'))).toString()
}

export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat('en-KE', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Africa/Nairobi',
  }).format(new Date(iso))
}

export function todayInNairobi(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi' }).format(new Date())
}

export function newIdempotencyKey(action: string): string {
  return `${action}-${crypto.randomUUID()}`
}

export function field(form: FormData, name: string): string {
  const value = form.get(name)
  return typeof value === 'string' ? value : ''
}
