import { and, eq } from 'drizzle-orm'
import { ledgerEntry, ledgerJournal } from './schema/ledger.js'
import type { Tx } from './tenancy.js'

export interface JournalLine {
  readonly accountId: string
  /** Signed minor units: debit positive, credit negative. */
  readonly amount: bigint
}

export class LedgerError extends Error {
  readonly code: 'UNBALANCED' | 'IDEMPOTENCY_CONFLICT'

  constructor(code: LedgerError['code'], message: string) {
    super(message)
    this.name = 'LedgerError'
    this.code = code
  }
}

export function journalProblems(lines: readonly JournalLine[]): string[] {
  const problems: string[] = []
  if (lines.length < 2) problems.push('a journal needs at least two lines')
  if (lines.some((l) => l.amount === 0n)) problems.push('journal lines must be non-zero')
  const total = lines.reduce((sum, l) => sum + l.amount, 0n)
  if (total !== 0n) problems.push(`journal lines sum to ${total}, not 0`)
  return problems
}

export interface PostJournalInput {
  readonly orgId: string
  readonly kind: string
  readonly description: string
  readonly idempotencyKey: string
  readonly transactionId?: string
  readonly createdBy?: string
  readonly lines: readonly JournalLine[]
}

export interface PostJournalResult {
  readonly journalId: string
  /** False when this idempotency key was already posted with identical lines. */
  readonly created: boolean
}

function sameLines(a: readonly JournalLine[], b: readonly JournalLine[]): boolean {
  const key = (l: JournalLine) => `${l.accountId}:${l.amount}`
  const sa = a.map(key).sort()
  const sb = b.map(key).sort()
  return sa.length === sb.length && sa.every((k, i) => k === sb[i])
}

/**
 * Posts a balanced journal once per idempotency key. The database re-checks
 * the balance at commit, so a bug here cannot persist an unbalanced journal.
 */
export async function postJournal(tx: Tx, input: PostJournalInput): Promise<PostJournalResult> {
  const problems = journalProblems(input.lines)
  if (problems.length > 0) throw new LedgerError('UNBALANCED', problems.join('; '))

  const [inserted] = await tx
    .insert(ledgerJournal)
    .values({
      orgId: input.orgId,
      kind: input.kind,
      description: input.description,
      idempotencyKey: input.idempotencyKey,
      transactionId: input.transactionId,
      createdBy: input.createdBy,
    })
    .onConflictDoNothing({ target: [ledgerJournal.orgId, ledgerJournal.idempotencyKey] })
    .returning({ id: ledgerJournal.id })

  if (inserted) {
    await tx.insert(ledgerEntry).values(
      input.lines.map((l) => ({ orgId: input.orgId, journalId: inserted.id, accountId: l.accountId, amount: l.amount })),
    )
    return { journalId: inserted.id, created: true }
  }

  const [existing] = await tx
    .select({ id: ledgerJournal.id, kind: ledgerJournal.kind })
    .from(ledgerJournal)
    .where(and(eq(ledgerJournal.orgId, input.orgId), eq(ledgerJournal.idempotencyKey, input.idempotencyKey)))
  if (!existing) throw new LedgerError('IDEMPOTENCY_CONFLICT', 'journal key conflict but no journal visible')
  const lines = await tx
    .select({ accountId: ledgerEntry.accountId, amount: ledgerEntry.amount })
    .from(ledgerEntry)
    .where(eq(ledgerEntry.journalId, existing.id))
  if (existing.kind !== input.kind || !sameLines(lines, input.lines)) {
    throw new LedgerError('IDEMPOTENCY_CONFLICT', `idempotency key ${input.idempotencyKey} was used for a different journal`)
  }
  return { journalId: existing.id, created: false }
}
