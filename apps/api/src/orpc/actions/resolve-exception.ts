import { ReconException } from '@paysync/contract'
import { schema } from '@paysync/db'
import { and, eq, sql } from 'drizzle-orm'
import { ActionError, type GuardedAction, type GuardedInput } from '../guarding/index.js'
import { toException } from '../mappers.js'

const { exception } = schema

type ResolveInput = GuardedInput & {
  readonly id: string
  readonly version: number
  readonly resolution: 'resolved' | 'dismissed'
  readonly note: string
}

/** exceptions.resolve: closes an open exception with a note (resolved, or nothing to do). */
export const resolveException: GuardedAction<ResolveInput, ReturnType<typeof toException>> = {
  procedure: 'exceptions.resolve',
  result: ReconException,
  async summary(tx, input) {
    const [row] = await tx.select({ summary: exception.summary }).from(exception).where(eq(exception.id, input.id))
    return `Close exception as ${input.resolution}: ${row?.summary ?? input.id}`
  },
  async run(tx, input) {
    const [row] = await tx.select().from(exception).where(eq(exception.id, input.id)).for('update')
    if (!row) throw new ActionError('NOT_FOUND', 'exception not found')
    if (row.version !== input.version) throw new ActionError('STALE_STATE', 'the exception changed', { currentVersion: row.version })
    if (row.status !== 'open') throw new ActionError('INVALID_STATE', 'only open exceptions can be closed', { status: row.status })
    const [updated] = await tx
      .update(exception)
      .set({ status: input.resolution, note: input.note, resolvedAt: sql`now()`, version: row.version + 1 })
      .where(and(eq(exception.id, row.id), eq(exception.status, 'open')))
      .returning()
    if (!updated) throw new Error('update returned no row')
    return { changed: true, result: toException(updated) }
  },
}
