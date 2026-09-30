import { ExpectedPayment, fromMoney, type Money } from '@paysync/contract'
import { CONSTRAINTS, SQLSTATE, pgConstraint, pgErrorCode, postInvoice, schema, type Tx } from '@paysync/db'
import { and, eq, ne } from 'drizzle-orm'
import { ActionError, type GuardedAction, type GuardedInput } from '../guarding/index.js'
import { normalizeReference, toExpectedPayment } from '../mappers.js'
import { selectExpected } from '../queries.js'
import { kes } from './shared.js'

const { expectedPayment } = schema

export async function findByReference(tx: Tx, normalized: string, exceptId?: string) {
  const [existing] = await tx
    .select({ id: expectedPayment.id })
    .from(expectedPayment)
    .where(and(eq(expectedPayment.referenceNormalized, normalized), exceptId ? ne(expectedPayment.id, exceptId) : undefined))
  return existing
}

/** A concurrent insert with the same reference lost the race to the unique constraint. */
export function isDuplicateReference(error: unknown): boolean {
  return pgErrorCode(error) === SQLSTATE.uniqueViolation && pgConstraint(error) === CONSTRAINTS.expectedPaymentReference
}

type CreateInput = GuardedInput & {
  readonly reference: string
  readonly amountDue: Money
  readonly dueDate?: string | undefined
  readonly description?: string | undefined
  readonly payerLabel?: string | undefined
}

/** expected.create: an invoice, rent period or fee the business expects; posted to the ledger as an invoice. */
export const createExpected: GuardedAction<CreateInput, ReturnType<typeof toExpectedPayment>> = {
  procedure: 'expected.create',
  result: ExpectedPayment,
  summary: (_tx, input) => Promise.resolve(`Add expected payment ${input.reference} (${kes(fromMoney(input.amountDue))} due)`),
  async run(tx, input, actor) {
    const normalized = normalizeReference(input.reference)
    const existing = await findByReference(tx, normalized)
    if (existing) throw new ActionError('DUPLICATE_REFERENCE', 'an expected payment with this reference exists', { existingId: existing.id })
    const [row] = await tx
      .insert(expectedPayment)
      .values({
        orgId: actor.orgId,
        reference: input.reference,
        referenceNormalized: normalized,
        amountDue: fromMoney(input.amountDue),
        dueDate: input.dueDate,
        description: input.description,
        payerLabel: input.payerLabel,
        createdBy: actor.actorId,
      })
      .returning()
    if (!row) throw new Error('insert returned no row')
    await postInvoice(tx, { orgId: row.orgId, key: `invoice:${row.id}`, reference: row.reference, delta: row.amountDue, createdBy: actor.actorId, reason: 'invoice' })
    return { result: toExpectedPayment(row, 0n), changed: true }
  },
}

type UpdateInput = GuardedInput & {
  readonly id: string
  readonly version: number
  readonly reference?: string | undefined
  readonly amountDue?: Money | undefined
  readonly dueDate?: string | null | undefined
  readonly description?: string | null | undefined
  readonly payerLabel?: string | null | undefined
}

/** expected.update: changes an open expected payment; an amount change posts an invoice adjustment. */
export const updateExpected: GuardedAction<UpdateInput, ReturnType<typeof toExpectedPayment>> = {
  procedure: 'expected.update',
  result: ExpectedPayment,
  async summary(tx, input) {
    const [found] = await selectExpected(tx, eq(expectedPayment.id, input.id), 1)
    const changes = [input.reference && 'reference', input.amountDue && `amount due to ${kes(fromMoney(input.amountDue))}`, input.dueDate !== undefined && 'due date']
      .filter(Boolean)
      .join(', ')
    return `Change expected payment ${found?.row.reference ?? input.id}${changes ? `: ${changes}` : ''}`
  },
  async run(tx, input, actor) {
    // Lock first: drizzle schema-qualifies FOR UPDATE OF, which Postgres rejects on a join.
    await tx.select({ id: expectedPayment.id }).from(expectedPayment).where(eq(expectedPayment.id, input.id)).for('update')
    const [found] = await selectExpected(tx, eq(expectedPayment.id, input.id), 1)
    if (!found) throw new ActionError('NOT_FOUND', 'expected payment not found')
    const { row, paid } = found
    if (row.version !== input.version) throw new ActionError('STALE_STATE', 'the expected payment changed', { currentVersion: row.version })
    if (row.status !== 'open' && row.status !== 'partially_paid') throw new ActionError('INVALID_STATE', 'only open expected payments change', { status: row.status })

    const changes: Partial<typeof expectedPayment.$inferInsert> = {}
    if (input.reference !== undefined && input.reference !== row.reference) {
      const normalized = normalizeReference(input.reference)
      const existing = await findByReference(tx, normalized, row.id)
      if (existing) throw new ActionError('DUPLICATE_REFERENCE', 'an expected payment with this reference exists', { existingId: existing.id })
      changes.reference = input.reference
      changes.referenceNormalized = normalized
    }
    if (input.amountDue !== undefined) {
      const amountDue = fromMoney(input.amountDue)
      if (amountDue < paid) throw new ActionError('INVALID_STATE', 'The amount due cannot be lower than what has already been paid.', { status: row.status })
      if (amountDue !== row.amountDue) changes.amountDue = amountDue
    }
    if (input.dueDate !== undefined && input.dueDate !== row.dueDate) changes.dueDate = input.dueDate
    if (input.description !== undefined && input.description !== row.description) changes.description = input.description
    if (input.payerLabel !== undefined && input.payerLabel !== row.payerLabel) changes.payerLabel = input.payerLabel

    if (Object.keys(changes).length === 0) return { result: toExpectedPayment(row, paid), changed: false }
    if (changes.amountDue !== undefined && paid > 0n) changes.status = changes.amountDue === paid ? 'paid' : 'partially_paid'
    const [updated] = await tx
      .update(expectedPayment)
      .set({ ...changes, version: row.version + 1 })
      .where(eq(expectedPayment.id, row.id))
      .returning()
    if (!updated) throw new Error('update returned no row')
    await postInvoice(tx, {
      orgId: updated.orgId,
      key: `invoice:${updated.id}:v${String(updated.version)}`,
      reference: updated.reference,
      delta: updated.amountDue - row.amountDue,
      createdBy: actor.actorId,
      reason: 'adjustment',
    })
    return { result: toExpectedPayment(updated, paid), changed: true }
  },
}
