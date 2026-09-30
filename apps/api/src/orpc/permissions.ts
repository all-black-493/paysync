import type { Contract } from '@paysync/contract'
import type { PermissionPath } from './permix.js'

type PermissionMap<T> = {
  [K in keyof T]: T[K] extends { '~orpc': unknown } ? PermissionPath | null : PermissionMap<T[K]>
}

/**
 * The Permix path each procedure requires. The compiler forces an entry for
 * every contract procedure; `null` means any authenticated caller.
 */
export const PERMISSIONS = {
  me: { get: null },
  transactions: { list: 'transaction.read', get: 'transaction.read', writeOffVariance: 'transaction.writeOff' },
  expected: {
    list: 'expectedPayment.read',
    get: 'expectedPayment.read',
    create: 'expectedPayment.create',
    update: 'expectedPayment.update',
    void: 'expectedPayment.void',
  },
  exceptions: { list: 'exception.read', get: 'exception.read', annotate: 'exception.annotate', resolve: 'exception.resolve' },
  matches: { list: 'match.read', suggest: 'match.suggest', confirm: 'match.confirm', unmatch: 'match.unmatch' },
  reversals: { request: 'reversal.request' },
  pendingActions: { list: 'pendingAction.read', get: 'pendingAction.read' },
  approvals: { decide: 'approval.approve' },
  apiKeys: { list: 'apiKey.read', create: 'apiKey.create', revoke: 'apiKey.delete' },
  reports: { dailySummary: 'report.read' },
  assistant: { chat: 'assistant.use' },
} satisfies PermissionMap<Contract>

export class UnmappedProcedureError extends Error {
  constructor(path: readonly string[]) {
    super(`procedure ${path.join('.')} has no permission mapping`)
    this.name = 'UnmappedProcedureError'
  }
}

/** Fails closed: an unmapped procedure path throws instead of allowing the call. */
export function permissionFor(path: readonly string[]): PermissionPath | null {
  let node: unknown = PERMISSIONS
  for (const segment of path) {
    if (typeof node !== 'object' || node === null || !Object.hasOwn(node, segment)) throw new UnmappedProcedureError(path)
    node = (node as Record<string, unknown>)[segment]
  }
  if (node === null) return null
  if (typeof node === 'string') return node as PermissionPath
  throw new UnmappedProcedureError(path)
}
