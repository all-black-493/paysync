export const CONSTRAINTS = {
  idempotencyKey: 'idempotency_record_orgId_key_unique',
  expectedPaymentReference: 'expected_payment_orgId_referenceNormalized_unique',
  receiptPerShortcode: 'mpesa_transaction_shortcodeId_receiptNumber_unique',
  journalBalanced: 'ledger_journal_balanced',
  allocationWithinAmount: 'core_allocation_within_amount',
  allocationWithinDue: 'core_allocation_within_due',
} as const

export const SQLSTATE = {
  uniqueViolation: '23505',
  checkViolation: '23514',
  appendOnly: 'PSA01',
  staleVersion: 'PSV01',
} as const
