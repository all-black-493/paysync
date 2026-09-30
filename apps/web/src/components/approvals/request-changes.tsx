import { formatKes } from '../../lib/format'
import { humanize } from '../../lib/labels'

// Only the fields an approver needs, in reading order. Payer-typed text and internals stay out.
const FIELDS: ReadonlyArray<readonly [string, string]> = [
  ['reference', 'Reference'],
  ['receiptNumber', 'Receipt'],
  ['status', 'Status'],
  ['amount', 'Amount'],
  ['amountDue', 'Amount due'],
  ['amountPaid', 'Paid'],
  ['allocated', 'Allocated'],
  ['writtenOff', 'Written off'],
  ['unallocated', 'Unallocated'],
  ['dueDate', 'Due'],
  ['method', 'Method'],
]

interface Money {
  readonly minor: string
  readonly currency: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMoney(value: unknown): value is Money {
  return isRecord(value) && typeof value.minor === 'string' && typeof value.currency === 'string'
}

function render(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (isMoney(value)) return formatKes(value)
  if (typeof value === 'string') return /^[a-z_]+$/.test(value) ? humanize(value) : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

function rows(record: unknown): Array<readonly [string, string]> {
  if (!isRecord(record)) return []
  const out: Array<readonly [string, string]> = []
  for (const [key, label] of FIELDS) {
    const text = render(record[key])
    if (text !== null) out.push([label, text])
  }
  if (out.length > 0) return out
  // Some results wrap the record (a reversal request carries its transaction).
  for (const nested of Object.values(record)) {
    const inner = isMoney(nested) ? [] : rows(nested)
    if (inner.length > 0) return inner
  }
  return out
}

/** A record as it reads after the action: the dry run before approval, the real result after. */
export function RequestChanges({ title, record }: { title: string; record: unknown }) {
  const items = rows(record)
  if (items.length === 0) return null
  return (
    <div className="stack">
      <span className="label">{title}</span>
      <dl className="changes">
        {items.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
