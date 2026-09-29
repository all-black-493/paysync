import { Match } from '@paysync/contract'
import { schema } from '@paysync/db'
import { undoMatch } from '@paysync/matching'
import { eq } from 'drizzle-orm'
import { ActionError, type GuardedAction, type GuardedInput } from '../guarding/index.js'
import { fromMatchError, kes, matchOutput } from './shared.js'

const { allocation, expectedPayment, match, mpesaTransaction } = schema

type UnmatchInput = GuardedInput & {
  readonly id: string
  readonly reason: string
}

/** matches.unmatch: destructive, always approved by someone else. */
export const unmatch: GuardedAction<UnmatchInput, Awaited<ReturnType<typeof matchOutput>>> = {
  procedure: 'matches.unmatch',
  result: Match,
  isolation: 'serializable',
  async summary(tx, input) {
    const [m] = await tx
      .select({ receipt: mpesaTransaction.receiptNumber, status: match.status })
      .from(match)
      .innerJoin(mpesaTransaction, eq(mpesaTransaction.id, match.transactionId))
      .where(eq(match.id, input.id))
    if (!m) throw new ActionError('NOT_FOUND', 'match not found')
    if (m.status !== 'active') throw new ActionError('INVALID_STATE', 'the match is already undone', { status: m.status })
    const parts = await tx
      .select({ amount: allocation.amount, reference: expectedPayment.reference })
      .from(allocation)
      .innerJoin(expectedPayment, eq(expectedPayment.id, allocation.expectedPaymentId))
      .where(eq(allocation.matchId, input.id))
    const total = parts.reduce((sum, p) => sum + p.amount, 0n)
    return `Undo the match of payment ${m.receipt} (${kes(total)}) to ${parts.map((p) => p.reference).join(', ')}: ${input.reason}`
  },
  async run(tx, input, actor) {
    await undoMatch(tx, { orgId: actor.orgId, matchId: input.id, createdBy: `${actor.kind}:${actor.actorId}` }).catch(fromMatchError)
    return { changed: true, result: await matchOutput(tx, input.id) }
  },
}
