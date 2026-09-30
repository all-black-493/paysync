import type { ExceptionOutput, PendingActionOutput } from '@paysync/contract'

export type Tone = 'active' | 'ok' | 'danger' | 'muted' | 'neutral'

export interface StatusLabel {
  readonly label: string
  readonly tone: Tone
}

export const EXCEPTION_KINDS: Record<ExceptionOutput['kind'], string> = {
  no_match: 'No match',
  low_confidence: 'Unsure match',
  partial_payment: 'Part paid',
  overpayment: 'Overpaid',
  duplicate: 'Duplicate',
  verification_failed: 'Not verified',
  amount_mismatch: 'Amount differs',
  balance_variance: 'Balance off',
  job_failed: 'Task failed',
  missing_callback: 'Missing callback',
  reversal_failed: 'Reversal failed',
}

export function exceptionStatus(item: ExceptionOutput): StatusLabel {
  return { label: EXCEPTION_KINDS[item.kind], tone: item.priority === 'high' ? 'danger' : 'active' }
}

export const TRANSACTION_STATUS: Record<string, StatusLabel> = {
  pending_verification: { label: 'Checking', tone: 'active' },
  verified: { label: 'Verified', tone: 'ok' },
  verification_failed: { label: 'Not verified', tone: 'danger' },
  reversed: { label: 'Reversed', tone: 'muted' },
}

export const EXPECTED_STATUS: Record<string, StatusLabel> = {
  open: { label: 'Open', tone: 'active' },
  partially_paid: { label: 'Part paid', tone: 'active' },
  paid: { label: 'Paid', tone: 'ok' },
  void: { label: 'Void', tone: 'muted' },
}

export const REQUEST_STATUS: Record<PendingActionOutput['status'], StatusLabel> = {
  pending: { label: 'Waiting', tone: 'active' },
  executed: { label: 'Done', tone: 'ok' },
  rejected: { label: 'Rejected', tone: 'muted' },
  failed: { label: 'Failed', tone: 'danger' },
  expired: { label: 'Expired', tone: 'muted' },
}

export const PROCEDURES: Record<string, string> = {
  'expected.void': 'Void',
  'matches.unmatch': 'Undo match',
  'matches.confirm': 'Match',
  'transactions.writeOffVariance': 'Write-off',
  'reversals.request': 'Reversal',
}

/** The guard's policy lines restate why the card exists; only extra reasons are worth showing. */
const POLICY_REASONS = new Set(['destructive: always needs approval', 'moves money: always needs approval'])

export function flaggedReasons(reasons: readonly string[]): string[] {
  return reasons.filter((r) => !POLICY_REASONS.has(r))
}

export function humanize(value: string): string {
  const text = value.replaceAll('_', ' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export const BUILT_IN_ROLES: ReadonlyArray<readonly [string, string]> = [
  ['viewer', 'Sees everything, changes nothing.'],
  ['clerk', 'Works the queue; requests voids, write-offs and undone matches.'],
  ['accountant', 'Clerk, plus approves requests and asks for reversals.'],
  ['admin', 'Accountant, plus team, roles and API keys.'],
  ['owner', 'Admin who created the organization.'],
]

/** Better Auth stores role names in lower case; show them with a capital. */
export function roleLabel(name: string): string {
  return name
    .split(',')
    .map((r) => r.trim())
    .map((r) => r.charAt(0).toUpperCase() + r.slice(1))
    .join(', ')
}
