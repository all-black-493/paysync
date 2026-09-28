import { and, eq } from 'drizzle-orm'
import { postJournal, type PostJournalResult } from './ledger.js'
import { exception } from './schema/core.js'
import { ledgerAccount } from './schema/ledger.js'
import type { Tx } from './tenancy.js'

type AccountKind = (typeof ledgerAccount.$inferInsert)['kind']

export const RECEIPT_ACCOUNTS = {
  float: { code: 'mpesa_float', name: 'M-Pesa float', kind: 'asset' },
  suspense: { code: 'suspense', name: 'Unallocated receipts', kind: 'liability' },
  applied: { code: 'applied_receipts', name: 'Receipts applied to expected payments', kind: 'liability' },
} as const satisfies Record<string, { code: string; name: string; kind: AccountKind }>

export async function ensureAccount(
  tx: Tx,
  orgId: string,
  account: { code: string; name: string; kind: AccountKind },
): Promise<string> {
  const [inserted] = await tx
    .insert(ledgerAccount)
    .values({ orgId, ...account })
    .onConflictDoNothing({ target: [ledgerAccount.orgId, ledgerAccount.code] })
    .returning({ id: ledgerAccount.id })
  if (inserted) return inserted.id
  const [existing] = await tx
    .select({ id: ledgerAccount.id })
    .from(ledgerAccount)
    .where(and(eq(ledgerAccount.orgId, orgId), eq(ledgerAccount.code, account.code)))
  if (!existing) throw new Error(`ledger account ${account.code} is not visible`)
  return existing.id
}

/**
 * The ledger posting for a verified payment: M-Pesa float up, unallocated
 * receipts up. Keyed by transaction, so it happens at most once.
 */
export async function postReceipt(
  tx: Tx,
  input: { orgId: string; transactionId: string; receiptNumber: string; amount: bigint; createdBy: string },
): Promise<PostJournalResult> {
  const float = await ensureAccount(tx, input.orgId, RECEIPT_ACCOUNTS.float)
  const suspense = await ensureAccount(tx, input.orgId, RECEIPT_ACCOUNTS.suspense)
  return postJournal(tx, {
    orgId: input.orgId,
    kind: 'receipt',
    description: `M-Pesa receipt ${input.receiptNumber}`,
    idempotencyKey: `receipt:${input.transactionId}`,
    transactionId: input.transactionId,
    createdBy: input.createdBy,
    lines: [
      { accountId: float, amount: input.amount },
      { accountId: suspense, amount: -input.amount },
    ],
  })
}

type ExceptionInsert = typeof exception.$inferInsert

/** Adds an exception unless one with the same dedupe key already exists. Returns whether it was added. */
export async function raiseException(
  tx: Tx,
  input: Pick<ExceptionInsert, 'orgId' | 'kind' | 'summary' | 'priority' | 'transactionId' | 'expectedPaymentId' | 'details'> & {
    dedupeKey: string
  },
): Promise<boolean> {
  const rows = await tx
    .insert(exception)
    .values(input)
    .onConflictDoNothing({ target: [exception.orgId, exception.dedupeKey] })
    .returning({ id: exception.id })
  return rows.length > 0
}
