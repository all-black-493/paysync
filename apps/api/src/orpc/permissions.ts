import type { Permission } from '@paysync/auth'
import type { Contract } from '@paysync/contract'

type PermissionMap<T> = {
  [K in keyof T]: T[K] extends { '~orpc': unknown } ? Permission | null : PermissionMap<T[K]>
}

/** Every procedure must appear here; `null` means any member of the organization. */
export const PERMISSIONS = {
  me: { get: null },
  transactions: { list: { transaction: ['read'] }, get: { transaction: ['read'] } },
  expected: {
    list: { expectedPayment: ['read'] },
    get: { expectedPayment: ['read'] },
    create: { expectedPayment: ['create'] },
    update: { expectedPayment: ['update'] },
  },
  exceptions: {
    list: { exception: ['read'] },
    get: { exception: ['read'] },
    annotate: { exception: ['annotate'] },
  },
  matches: { list: { match: ['read'] } },
  reports: { dailySummary: { report: ['read'] } },
} satisfies PermissionMap<Contract>

export class UnmappedProcedureError extends Error {
  constructor(path: readonly string[]) {
    super(`procedure ${path.join('.')} has no permission mapping`)
    this.name = 'UnmappedProcedureError'
  }
}

/** Fails closed: an unmapped path throws instead of allowing the call. */
export function permissionFor(path: readonly string[]): Permission | null {
  let node: unknown = PERMISSIONS
  for (const segment of path) {
    if (typeof node !== 'object' || node === null || !Object.hasOwn(node, segment)) throw new UnmappedProcedureError(path)
    node = (node as Record<string, unknown>)[segment]
  }
  if (node === null) return null
  if (typeof node === 'object' && Object.values(node).every((actions) => Array.isArray(actions))) {
    return node
  }
  throw new UnmappedProcedureError(path)
}
