import { RECEIPT_ACCOUNTS, allocate, ensureAccount, postJournal, schema, type Tx } from '@paysync/db'
import { and, asc, eq, gt, inArray, or, sql } from 'drizzle-orm'
import type { Candidate, PaymentFacts } from './decide.js'

const { allocation, exception, expectedPayment, match, mpesaTransaction, varianceWriteOff } = schema

export class MatchError extends Error {
  readonly code: 'NOT_FOUND' | 'NOT_VERIFIED' | 'STALE_STATE' | 'EXPECTED_CLOSED' | 'EXCEEDS_DUE' | 'EXCEEDS_AMOUNT' | 'ALREADY_UNMATCHED'
  readonly details: Record<string, string>

  constructor(code: MatchError['code'], message: string, details: Record<string, string> = {}) {
    super(message)
    this.name = 'MatchError'
    this.code = code
    this.details = details
  }
}

/** Paid ones stay candidates for a while so a second payment can be flagged as a duplicate. */
const PAID_LOOKBACK_DAYS = 90

function paidSums(tx: Tx) {
  return tx
    .select({ expectedPaymentId: allocation.expectedPaymentId, paid: sql<string | null>`sum(${allocation.amount})::text`.as('paid') })
    .from(allocation)
    .innerJoin(match, and(eq(match.id, allocation.matchId), eq(match.status, 'active')))
    .groupBy(allocation.expectedPaymentId)
    .as('paid_sums')
}

export async function loadCandidates(tx: Tx, ids?: readonly string[]): Promise<Candidate[]> {
  const paid = paidSums(tx)
  const rows = await tx
    .select({
      id: expectedPayment.id,
      reference: expectedPayment.reference,
      description: expectedPayment.description,
      amountDue: expectedPayment.amountDue,
      dueDate: expectedPayment.dueDate,
      status: expectedPayment.status,
      paid: paid.paid,
    })
    .from(expectedPayment)
    .leftJoin(paid, eq(paid.expectedPaymentId, expectedPayment.id))
    .where(
      ids
        ? inArray(expectedPayment.id, [...ids])
        : or(
            inArray(expectedPayment.status, ['open', 'partially_paid']),
            and(
              eq(expectedPayment.status, 'paid'),
              gt(expectedPayment.updatedAt, sql`now() - make_interval(days => ${PAID_LOOKBACK_DAYS})`),
            ),
          ),
    )
    .orderBy(asc(expectedPayment.id))
  return rows.map((r) => ({ ...r, paid: BigInt(r.paid ?? '0') }))
}

export interface TransactionForMatching extends PaymentFacts {
  readonly id: string
  readonly receiptNumber: string
  readonly status: string
  readonly version: number
  /** Active allocations only (`allocated` also counts write-offs). */
  readonly allocations: bigint
  readonly writtenOff: bigint
}

/** Locks the transaction row: every allocation for it goes through this lock. */
export function lockTransaction(tx: Tx, transactionId: string): Promise<TransactionForMatching | null> {
  return readTransaction(tx, transactionId, true)
}

export async function readTransaction(tx: Tx, transactionId: string, lock = false): Promise<TransactionForMatching | null> {
  const query = tx.select().from(mpesaTransaction).where(eq(mpesaTransaction.id, transactionId))
  const [row] = lock ? await query.for('update') : await query
  if (!row) return null
  const [sum] = await tx
    .select({ total: sql<string>`coalesce(sum(${allocation.amount}), 0)::text` })
    .from(allocation)
    .innerJoin(match, and(eq(match.id, allocation.matchId), eq(match.status, 'active')))
    .where(eq(allocation.transactionId, transactionId))
  const [off] = await tx
    .select({ total: sql<string>`coalesce(sum(${varianceWriteOff.amount}), 0)::text` })
    .from(varianceWriteOff)
    .where(eq(varianceWriteOff.transactionId, transactionId))
  const allocations = BigInt(sum?.total ?? '0')
  const writtenOff = BigInt(off?.total ?? '0')
  return {
    id: row.id,
    receiptNumber: row.receiptNumber,
    status: row.status,
    version: row.version,
    amount: row.amount,
    // Written-off money is no longer available to allocate either.
    allocated: allocations + writtenOff,
    allocations,
    writtenOff,
    reference: row.billRefNumber,
    transactedAt: row.transactedAt,
  }
}

export interface ApplyMatchInput {
  readonly orgId: string
  readonly transactionId: string
  /** When given, the transaction must still be at this version (optimistic concurrency). */
  readonly expectedVersion?: number
  readonly method: 'exact' | 'rule' | 'jev' | 'manual'
  readonly parts: ReadonlyArray<{ readonly expectedPaymentId: string; readonly amount: bigint }>
  /** Jev-based matches keep the confidence and the full distribution (§7.3). */
  readonly jev?: { readonly confidence: number; readonly probabilities: Readonly<Record<string, number>> }
  readonly actorUserId?: string | null
  readonly createdBy: string
}

/**
 * The only writer of allocations. Locks the transaction, then the expected
 * payments in id order (no deadlocks between concurrent matches), re-checks
 * every amount against what is still due, updates statuses, and moves the
 * amount from unallocated receipts to the invoices it settles (receivables).
 */
export async function applyMatch(tx: Tx, input: ApplyMatchInput): Promise<{ matchId: string }> {
  if (input.parts.length === 0) throw new MatchError('EXCEEDS_AMOUNT', 'a match needs at least one allocation')
  const payment = await lockTransaction(tx, input.transactionId)
  if (!payment) throw new MatchError('NOT_FOUND', 'transaction not found')
  if (input.expectedVersion !== undefined && payment.version !== input.expectedVersion) {
    throw new MatchError('STALE_STATE', 'the transaction changed', { currentVersion: String(payment.version) })
  }
  if (payment.status !== 'verified') {
    throw new MatchError('NOT_VERIFIED', 'only verified payments can be matched', { status: payment.status })
  }
  const total = input.parts.reduce((sum, p) => sum + p.amount, 0n)
  if (total > payment.amount - payment.allocated) {
    throw new MatchError('EXCEEDS_AMOUNT', 'the allocations exceed the unallocated amount of the payment', {
      unallocatedMinor: (payment.amount - payment.allocated).toString(),
    })
  }

  const ids = [...new Set(input.parts.map((p) => p.expectedPaymentId))].sort()
  if (ids.length !== input.parts.length) throw new MatchError('EXCEEDS_DUE', 'each expected payment may appear once')
  await tx.select({ id: expectedPayment.id }).from(expectedPayment).where(inArray(expectedPayment.id, ids)).orderBy(asc(expectedPayment.id)).for('update')
  const candidates = new Map((await loadCandidates(tx, ids)).map((c) => [c.id, c]))
  for (const part of input.parts) {
    const c = candidates.get(part.expectedPaymentId)
    if (!c) throw new MatchError('NOT_FOUND', 'expected payment not found', { expectedPaymentId: part.expectedPaymentId })
    if (c.status !== 'open' && c.status !== 'partially_paid') {
      throw new MatchError('EXPECTED_CLOSED', 'the expected payment is not open', { expectedPaymentId: c.id, status: c.status })
    }
    if (part.amount <= 0n || part.amount > c.amountDue - c.paid) {
      throw new MatchError('EXCEEDS_DUE', 'the allocation is more than the amount still due', {
        expectedPaymentId: c.id,
        dueMinor: (c.amountDue - c.paid).toString(),
      })
    }
  }

  const [created] = await tx
    .insert(match)
    .values({
      orgId: input.orgId,
      transactionId: input.transactionId,
      method: input.method,
      actorUserId: input.actorUserId ?? null,
      confidence: input.jev ? input.jev.confidence.toFixed(4) : null,
      jevProbabilities: input.jev?.probabilities ?? null,
    })
    .returning({ id: match.id })
  if (!created) throw new Error('match insert returned no row')
  await allocate(tx, { orgId: input.orgId, transactionId: input.transactionId, matchId: created.id, parts: input.parts })

  for (const part of input.parts) {
    const c = candidates.get(part.expectedPaymentId)
    if (!c) continue
    await tx
      .update(expectedPayment)
      .set({ status: c.paid + part.amount === c.amountDue ? 'paid' : 'partially_paid', version: sql`${expectedPayment.version} + 1` })
      .where(eq(expectedPayment.id, c.id))
  }
  await tx
    .update(mpesaTransaction)
    .set({ version: payment.version + 1 })
    .where(eq(mpesaTransaction.id, input.transactionId))

  // Unallocated receipts settle the invoices they pay.
  const suspense = await ensureAccount(tx, input.orgId, RECEIPT_ACCOUNTS.suspense)
  const receivables = await ensureAccount(tx, input.orgId, RECEIPT_ACCOUNTS.receivables)
  await postJournal(tx, {
    orgId: input.orgId,
    kind: 'allocation',
    description: `Allocation of match ${created.id}`,
    idempotencyKey: `allocation:${created.id}`,
    transactionId: input.transactionId,
    createdBy: input.createdBy,
    lines: [
      { accountId: suspense, amount: total },
      { accountId: receivables, amount: -total },
    ],
  })
  return { matchId: created.id }
}

/**
 * Reverses a match: its allocations stop counting, expected payments reopen,
 * the ledger entry is reversed. Same lock order as applyMatch. Unmatching is
 * final (a database trigger refuses reactivation).
 */
export async function undoMatch(tx: Tx, input: { orgId: string; matchId: string; createdBy: string }): Promise<{ transactionId: string }> {
  const [found] = await tx.select().from(match).where(eq(match.id, input.matchId))
  if (!found) throw new MatchError('NOT_FOUND', 'match not found')
  const payment = await lockTransaction(tx, found.transactionId)
  if (!payment) throw new MatchError('NOT_FOUND', 'transaction not found')
  const [locked] = await tx.select().from(match).where(eq(match.id, input.matchId)).for('update')
  if (locked?.status !== 'active') throw new MatchError('ALREADY_UNMATCHED', 'the match is already undone', { status: locked?.status ?? 'unknown' })

  const parts = await tx.select().from(allocation).where(eq(allocation.matchId, locked.id))
  const ids = [...new Set(parts.map((p) => p.expectedPaymentId))].sort()
  if (ids.length > 0) {
    await tx.select({ id: expectedPayment.id }).from(expectedPayment).where(inArray(expectedPayment.id, ids)).orderBy(asc(expectedPayment.id)).for('update')
  }
  await tx
    .update(match)
    .set({ status: 'unmatched', unmatchedAt: sql`now()`, version: locked.version + 1 })
    .where(eq(match.id, locked.id))

  // Paid totals after the match stopped counting.
  const candidates = new Map((ids.length === 0 ? [] : await loadCandidates(tx, ids)).map((c) => [c.id, c]))
  for (const id of ids) {
    const c = candidates.get(id)
    if (!c || c.status === 'void') continue
    const status = c.paid === 0n ? 'open' : c.paid >= c.amountDue ? 'paid' : 'partially_paid'
    if (status !== c.status) {
      await tx.update(expectedPayment).set({ status, version: sql`${expectedPayment.version} + 1` }).where(eq(expectedPayment.id, id))
    }
  }
  await tx.update(mpesaTransaction).set({ version: payment.version + 1 }).where(eq(mpesaTransaction.id, payment.id))

  const total = parts.reduce((sum, p) => sum + p.amount, 0n)
  if (total > 0n) {
    const suspense = await ensureAccount(tx, input.orgId, RECEIPT_ACCOUNTS.suspense)
    const receivables = await ensureAccount(tx, input.orgId, RECEIPT_ACCOUNTS.receivables)
    await postJournal(tx, {
      orgId: input.orgId,
      kind: 'unallocation',
      description: `Match ${locked.id} undone`,
      idempotencyKey: `unallocation:${locked.id}`,
      transactionId: payment.id,
      createdBy: input.createdBy,
      lines: [
        { accountId: receivables, amount: total },
        { accountId: suspense, amount: -total },
      ],
    })
  }
  return { transactionId: payment.id }
}

/** Matching exceptions for a transaction that a confirmed match settles. */
export async function resolveMatchExceptions(tx: Tx, transactionId: string, note: string): Promise<number> {
  const rows = await tx
    .update(exception)
    .set({ status: 'resolved', resolvedAt: sql`now()`, note: sql`coalesce(${exception.note}, ${note})`, version: sql`${exception.version} + 1` })
    .where(
      and(
        eq(exception.transactionId, transactionId),
        eq(exception.status, 'open'),
        inArray(exception.kind, ['no_match', 'low_confidence', 'duplicate', 'partial_payment', 'overpayment']),
      ),
    )
    .returning({ id: exception.id })
  return rows.length
}
