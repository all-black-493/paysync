import { ExpectedPayment, fromMoney } from '@paysync/contract'
import { postInvoice, schema } from '@paysync/db'
import { eq } from 'drizzle-orm'
import { ActionError, type GuardedAction, type GuardedInput } from '../guarding/index.js'
import { expectedOutput, kes } from './shared.js'

const { expectedPayment } = schema

type VoidInput = GuardedInput & {
  readonly id: string
  readonly version: number
  readonly reason: string
}

/** expected.void: destructive; reverses the invoice in the ledger. */
export const voidExpected: GuardedAction<VoidInput, Awaited<ReturnType<typeof expectedOutput>>> = {
  procedure: 'expected.void',
  result: ExpectedPayment,
  async summary(tx, input) {
    const e = await expectedOutput(tx, input.id)
    return `Void expected payment ${e.reference} (${kes(fromMoney(e.amountDue))} due): ${input.reason}`
  },
  async run(tx, input, actor) {
    const [row] = await tx.select().from(expectedPayment).where(eq(expectedPayment.id, input.id)).for('update')
    if (!row) throw new ActionError('NOT_FOUND', 'expected payment not found')
    if (row.version !== input.version) throw new ActionError('STALE_STATE', 'the expected payment changed', { currentVersion: row.version })
    if (row.status !== 'open') {
      throw new ActionError('INVALID_STATE', 'only an open expected payment with nothing allocated can be voided', { status: row.status })
    }
    await tx.update(expectedPayment).set({ status: 'void', version: row.version + 1 }).where(eq(expectedPayment.id, row.id))
    await postInvoice(tx, {
      orgId: actor.orgId,
      key: `invoice:${row.id}:void`,
      reference: row.reference,
      delta: -row.amountDue,
      createdBy: `${actor.kind}:${actor.actorId}`,
      reason: 'void',
    })
    return { changed: true, result: await expectedOutput(tx, row.id) }
  },
}
