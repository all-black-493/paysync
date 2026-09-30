'use client'

import type { MatchOutput, TransactionOutput } from '@paysync/contract'
import { field, formatAmount, parseKes } from '../../lib/format'
import { client } from '../../lib/orpc'
import { RequestAction } from '../requests/request-action'

export interface TransactionPermissions {
  readonly writeOff: boolean
  readonly reverse: boolean
  readonly unmatch: boolean
}

/** Guarded requests on one payment; each waits for an approver. */
export function TransactionActions({
  transaction: t,
  matches,
  can,
}: {
  transaction: TransactionOutput
  matches: readonly MatchOutput[]
  can: TransactionPermissions
}) {
  const verified = t.status === 'verified'
  const unallocated = BigInt(t.unallocated.minor)
  const untouched = unallocated === BigInt(t.amount.minor)
  return (
    <div className="actions">
      {verified && can.writeOff && unallocated > 0n ? (
        <RequestAction
          label="Write off"
          submitLabel="Request write-off"
          submit={({ reason, form, idempotencyKey }) => {
            const minor = parseKes(field(form, 'amount'))
            if (minor === null || minor === '0') return Promise.reject(new Error('Enter an amount'))
            return client.transactions.writeOffVariance({ transactionId: t.id, version: t.version, amount: { minor, currency: 'KES' }, reason, idempotencyKey })
          }}
        >
          <label className="field">
            <span>Amount (KES)</span>
            <input name="amount" inputMode="decimal" required defaultValue={formatAmount(t.unallocated)} autoFocus />
          </label>
        </RequestAction>
      ) : null}
      {verified && can.reverse && untouched ? (
        <RequestAction
          label="Reverse"
          submitLabel="Request reversal"
          submit={({ reason, idempotencyKey }) => client.reversals.request({ transactionId: t.id, version: t.version, reason, idempotencyKey })}
        />
      ) : null}
      {can.unmatch
        ? matches.map((m) => (
            <RequestAction
              key={m.id}
              label="Undo match"
              submitLabel="Request undo"
              submit={({ reason, idempotencyKey }) => client.matches.unmatch({ id: m.id, reason, idempotencyKey })}
            />
          ))
        : null}
    </div>
  )
}
