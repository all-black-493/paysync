import { ReversalRequest, type Money } from '@paysync/contract'
import { enqueueJob, schema } from '@paysync/db'
import { and, count, eq, gte, inArray } from 'drizzle-orm'
import { ActionError, type GuardedAction, type GuardedInput } from '../guarding/index.js'
import { kes, paymentFor, startOfTodayEat } from './shared.js'

const { darajaRequest, mpesaTransaction } = schema

type ReversalInput = GuardedInput & {
  readonly transactionId: string
  readonly version: number
  readonly reason: string
}

interface ReversalOutput {
  transactionId: string
  receiptNumber: string
  amount: Money
  status: 'queued'
  reason: string
}

/**
 * reversals.request: moves money. Always two approvers; once approved it only
 * queues the Daraja call (the worker sends it once, sandbox only).
 */
export const requestReversal: GuardedAction<ReversalInput, ReversalOutput> = {
  procedure: 'reversals.request',
  result: ReversalRequest,
  async summary(tx, input) {
    const payment = await paymentFor(tx, input.transactionId, input.version, false)
    return `Reverse payment ${payment.receiptNumber} of ${kes(payment.amount)} back to the payer: ${input.reason}`
  },
  async overBudget(tx, _input, policy) {
    const [row] = await tx
      .select({ n: count() })
      .from(darajaRequest)
      .where(and(eq(darajaRequest.kind, 'reversal'), gte(darajaRequest.createdAt, startOfTodayEat())))
    const used = row?.n ?? 0
    if (used < policy.reversalDailyBudget) return null
    return { budget: 'reversals', limit: String(policy.reversalDailyBudget), used: String(used) }
  },
  async run(tx, input, actor) {
    const payment = await paymentFor(tx, input.transactionId, input.version, true)
    if (payment.status !== 'verified') throw new ActionError('INVALID_STATE', 'only verified payments can be reversed', { status: payment.status })
    if (payment.allocated > 0n) throw new ActionError('INVALID_STATE', 'unmatch the payment before reversing it', { status: 'allocated' })
    const [open] = await tx
      .select({ id: darajaRequest.id })
      .from(darajaRequest)
      .where(
        and(
          eq(darajaRequest.transactionId, payment.id),
          eq(darajaRequest.kind, 'reversal'),
          inArray(darajaRequest.status, ['initiated', 'accepted', 'completed']),
        ),
      )
      .limit(1)
    if (open) throw new ActionError('INVALID_STATE', 'a reversal for this payment already exists', { status: 'reversal_in_progress' })
    const [txRow] = await tx.select({ shortcodeId: mpesaTransaction.shortcodeId }).from(mpesaTransaction).where(eq(mpesaTransaction.id, payment.id))
    if (!txRow) throw new ActionError('NOT_FOUND', 'transaction not found')
    const [created] = await tx
      .insert(darajaRequest)
      .values({ orgId: actor.orgId, shortcodeId: txRow.shortcodeId, kind: 'reversal', transactionId: payment.id, receiptNumber: payment.receiptNumber })
      .returning({ id: darajaRequest.id })
    if (!created) throw new Error('reversal request insert returned no row')
    await tx.update(mpesaTransaction).set({ version: payment.version + 1 }).where(eq(mpesaTransaction.id, payment.id))
    await enqueueJob(tx, 'execute_reversal', { orgId: actor.orgId, darajaRequestId: created.id }, { jobKey: `reversal:${created.id}` })
    return {
      changed: true,
      result: {
        transactionId: payment.id,
        receiptNumber: payment.receiptNumber,
        amount: { minor: payment.amount.toString(), currency: 'KES' },
        status: 'queued',
        reason: input.reason,
      },
    }
  },
}
