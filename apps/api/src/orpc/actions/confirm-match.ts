import { Match, fromMoney, type Money } from '@paysync/contract'
import { schema } from '@paysync/db'
import { applyMatch, referenceKey, resolveMatchExceptions } from '@paysync/matching'
import { inArray } from 'drizzle-orm'
import type { GuardedAction, GuardedInput } from '../guarding/index.js'
import { fromMatchError, kes, matchOutput, paymentFor } from './shared.js'

const { expectedPayment } = schema

type ConfirmInput = GuardedInput & {
  readonly transactionId: string
  readonly version: number
  readonly allocations: ReadonlyArray<{ readonly expectedPaymentId: string; readonly amount: Money }>
}

/** matches.confirm: a write that needs a person only when a machine's choice is in doubt. */
export const confirmMatch: GuardedAction<ConfirmInput, Awaited<ReturnType<typeof matchOutput>>> = {
  procedure: 'matches.confirm',
  result: Match,
  isolation: 'serializable',
  async summary(tx, input) {
    const payment = await paymentFor(tx, input.transactionId, input.version, false)
    const total = input.allocations.reduce((sum, a) => sum + fromMoney(a.amount), 0n)
    return `Match ${kes(total)} of payment ${payment.receiptNumber} to ${input.allocations.length} expected payment(s)`
  },
  // Doubt: the payer's reference does not point at what was chosen.
  async checks(tx, input) {
    const payment = await paymentFor(tx, input.transactionId, input.version, false)
    const ids = input.allocations.map((a) => a.expectedPaymentId)
    const rows = await tx
      .select({ id: expectedPayment.id, reference: expectedPayment.reference })
      .from(expectedPayment)
      .where(inArray(expectedPayment.id, ids))
    const key = referenceKey(payment.reference ?? '')
    const doubts = rows.filter((r) => key === '' || referenceKey(r.reference) !== key).map((r) => `the payment reference does not fit ${r.reference}`)
    return { blocks: [], doubts }
  },
  async run(tx, input, actor) {
    const { matchId } = await applyMatch(tx, {
      orgId: actor.orgId,
      transactionId: input.transactionId,
      expectedVersion: input.version,
      method: 'manual',
      parts: input.allocations.map((a) => ({ expectedPaymentId: a.expectedPaymentId, amount: fromMoney(a.amount) })),
      actorUserId: actor.kind === 'user' ? actor.actorId : null,
      createdBy: `${actor.kind}:${actor.actorId}`,
    }).catch(fromMatchError)
    await resolveMatchExceptions(tx, input.transactionId, 'Matched by hand.')
    return { changed: true, result: await matchOutput(tx, matchId) }
  },
}
