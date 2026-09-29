import type { schema } from '@paysync/db'
import { z } from 'zod'
import { ActionError, type GuardErrors } from './types.js'

export function mapActionError(errors: GuardErrors, error: unknown): never {
  if (!(error instanceof ActionError)) throw error
  switch (error.code) {
    case 'NOT_FOUND':
      throw errors.NOT_FOUND()
    case 'STALE_STATE':
      if (errors.STALE_STATE) throw errors.STALE_STATE({ data: { currentVersion: Number(error.data.currentVersion) } })
      break
    case 'INVALID_STATE':
      if (errors.INVALID_STATE) throw errors.INVALID_STATE({ data: { status: String(error.data.status) } })
      break
    case 'ALLOCATION_REJECTED':
      if (errors.ALLOCATION_REJECTED) {
        const data = error.data
        throw errors.ALLOCATION_REJECTED({
          data: {
            ...(typeof data.expectedPaymentId === 'string' ? { expectedPaymentId: data.expectedPaymentId } : {}),
            ...(typeof data.unallocated === 'string' ? { unallocated: data.unallocated } : {}),
            ...(typeof data.due === 'string' ? { due: data.due } : {}),
          },
        })
      }
      break
  }
  throw errors.BLOCKED({ data: { reason: error.message } })
}

export function approvalRequired(errors: GuardErrors, row: typeof schema.pendingAction.$inferSelect): Error {
  return errors.APPROVAL_REQUIRED({
    data: {
      pendingActionId: row.id,
      summary: row.summary,
      approvalsRequired: row.approvalsRequired,
      reasons: z.array(z.string()).parse(row.reasons),
      preview: row.preview,
    },
  })
}
