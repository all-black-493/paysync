import { formatDateTime, formatRelative, formatShortDateTime } from '../../lib/format'

/** Relative by default ("2 days ago"); the exact East Africa time is on hover. */
export function Time({ iso, style = 'relative' }: { iso: string; style?: 'relative' | 'short' }) {
  return (
    <time dateTime={iso} title={formatDateTime(iso)}>
      {style === 'relative' ? formatRelative(iso) : formatShortDateTime(iso)}
    </time>
  )
}
