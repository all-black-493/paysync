import { Transaction, fromMoney, type Money } from '@paysync/contract'
import { RECEIPT_ACCOUNTS, ensureAccount, postJournal, schema, type Tx } from '@paysync/db'
import { eq, gte, sql } from 'drizzle-orm'
import { ActionError, type GuardedAction, type GuardedInput } from '../guarding/index.js'
import { kes, paymentFor, startOfTodayEat, transactionOutput, paymentRecords } from './shared.js'

const { mpesaTransaction, varianceWriteOff } = schema

type WriteOffInput = GuardedInput & {
  readonly transactionId: string
  readonly version: number
  readonly amount: Money
  readonly reason: string
}

async function writtenOffToday(tx: Tx): Promise<bigint> {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${varianceWriteOff.amount}), 0)::text` })
    .from(varianceWriteOff)
    .where(gte(varianceWriteOff.createdAt, startOfTodayEat()))
  return BigInt(row?.total ?? '0')
}

/** transactions.writeOffVariance: destructive, capped per write-off and budgeted per day. */
export const writeOffVariance: GuardedAction<WriteOffInput, Awaited<ReturnType<typeof transactionOutput>>> = {
  procedure: 'transactions.writeOffVariance',
  result: Transaction,
  isolation: 'serializable',
  records: (tx, input) => paymentRecords(tx, input.transactionId),
  async summary(tx, input) {
    const payment = await paymentFor(tx, input.transactionId, input.version, false)
    return `Write off ${kes(fromMoney(input.amount))} of payment ${payment.receiptNumber}: ${input.reason}`
  },
  checks(_tx, input, _caller, policy) {
    const amount = fromMoney(input.amount)
    return Promise.resolve({
      blocks: amount > policy.writeOffCapMinor ? [`above the write-off cap of ${kes(policy.writeOffCapMinor)}`] : [],
      doubts: [],
    })
  },
  async overBudget(tx, input, policy) {
    const used = await writtenOffToday(tx)
    if (used + fromMoney(input.amount) <= policy.writeOffDailyBudgetMinor) return null
    return { budget: 'writeoffs', limit: policy.writeOffDailyBudgetMinor.toString(), used: used.toString() }
  },
  async run(tx, input, actor) {
    const payment = await paymentFor(tx, input.transactionId, input.version, true)
    if (payment.status !== 'verified') throw new ActionError('INVALID_STATE', 'only verified payments can be written off', { status: payment.status })
    const amount = fromMoney(input.amount)
    const available = payment.amount - payment.allocated
    if (amount <= 0n || amount > available) {
      throw new ActionError('ALLOCATION_REJECTED', 'the write-off is more than the unallocated amount', { unallocated: available.toString() })
    }
    const [row] = await tx
      .insert(varianceWriteOff)
      .values({ orgId: actor.orgId, transactionId: payment.id, amount, reason: input.reason, createdBy: actor.actorId })
      .returning({ id: varianceWriteOff.id })
    if (!row) throw new Error('write-off insert returned no row')
    await tx.update(mpesaTransaction).set({ version: payment.version + 1 }).where(eq(mpesaTransaction.id, payment.id))
    const suspense = await ensureAccount(tx, actor.orgId, RECEIPT_ACCOUNTS.suspense)
    const variance = await ensureAccount(tx, actor.orgId, RECEIPT_ACCOUNTS.variance)
    await postJournal(tx, {
      orgId: actor.orgId,
      kind: 'write_off',
      description: `Variance written off on ${payment.receiptNumber}`,
      idempotencyKey: `writeoff:${row.id}`,
      transactionId: payment.id,
      createdBy: `${actor.kind}:${actor.actorId}`,
      lines: [
        { accountId: suspense, amount },
        { accountId: variance, amount: -amount },
      ],
    })
    return { changed: true, result: await transactionOutput(tx, payment.id) }
  },
}
