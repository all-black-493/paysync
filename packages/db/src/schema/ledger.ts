import { sql } from 'drizzle-orm'
import { bigint, check, index, pgSchema, text, unique, uuid } from 'drizzle-orm/pg-core'
import { createdAt, currency, id, idOrgUnique, oneOf, orgId, sameOrg } from './columns.js'
import { mpesaTransaction } from './core.js'

export const ledger = pgSchema('ledger')

export const ACCOUNT_KINDS = ['asset', 'liability', 'equity', 'income', 'expense'] as const

export const ledgerAccount = ledger.table(
  'account',
  {
    id: id(),
    orgId: orgId(),
    code: text().notNull(),
    name: text().notNull(),
    kind: text({ enum: ACCOUNT_KINDS }).notNull(),
    currency: currency(),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.orgId, t.code),
    idOrgUnique('account_id_org_unique', t),
    check('account_kind', oneOf('kind', ACCOUNT_KINDS)),
    check('account_currency', sql`${t.currency} = 'KES'`),
  ],
)

export const ledgerJournal = ledger.table(
  'journal',
  {
    id: id(),
    orgId: orgId(),
    kind: text().notNull(),
    description: text().notNull(),
    transactionId: uuid(),
    idempotencyKey: text().notNull(),
    createdBy: text(),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.orgId, t.idempotencyKey),
    idOrgUnique('journal_id_org_unique', t),
    sameOrg('journal_transaction_fk', { column: t.transactionId, orgId: t.orgId }, mpesaTransaction),
    index().on(t.orgId, t.createdAt),
    check('journal_idempotency_key_length', sql`char_length(${t.idempotencyKey}) BETWEEN 1 AND 200`),
  ],
)

export const ledgerEntry = ledger.table(
  'entry',
  {
    id: id(),
    orgId: orgId(),
    journalId: uuid().notNull(),
    accountId: uuid().notNull(),
    /** Signed minor units: debits positive, credits negative. */
    amount: bigint({ mode: 'bigint' }).notNull(),
    currency: currency(),
    createdAt: createdAt(),
  },
  (t) => [
    index().on(t.journalId),
    sameOrg('entry_journal_fk', { column: t.journalId, orgId: t.orgId }, ledgerJournal),
    sameOrg('entry_account_fk', { column: t.accountId, orgId: t.orgId }, ledgerAccount),
    index().on(t.orgId, t.accountId),
    check('entry_amount_nonzero', sql`${t.amount} <> 0`),
    check('entry_currency', sql`${t.currency} = 'KES'`),
  ],
)
