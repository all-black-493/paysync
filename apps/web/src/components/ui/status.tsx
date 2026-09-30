import type { StatusLabel } from '../../lib/labels'

export function Status({ status }: { status: StatusLabel }) {
  return (
    <span className="status" data-tone={status.tone}>
      {status.label}
    </span>
  )
}
