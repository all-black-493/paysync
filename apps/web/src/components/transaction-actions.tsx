'use client'

import type { TransactionOutput } from '@paysync/contract'
import { useQuery } from '@tanstack/react-query'
import { field, formatKes, parseKes } from '../lib/format'
import { client, orpc } from '../lib/orpc'
import { RequestAction } from './request-action'

export interface TransactionPermissions {
  readonly writeOff: boolean
  readonly reverse: boolean
  readonly unmatch: boolean
}

/** Guarded requests on one payment; each waits for an approver. */
export function TransactionActions({ transaction: t, can }: { transaction: TransactionOutput; can: TransactionPermissions }) {
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
          <label>
            Amount (KES)
            <input name="amount" inputMode="decimal" required defaultValue={formatKes(t.unallocated).replace('KES ', '')} />
          </label>
        </RequestAction>
      ) : null}
      {verified && can.reverse && untouched ? (
        <RequestAction
          label="Reverse"
          submitLabel="Request reversal (two approvers)"
          submit={({ reason, idempotencyKey }) => client.reversals.request({ transactionId: t.id, version: t.version, reason, idempotencyKey })}
        />
      ) : null}
      {can.unmatch && BigInt(t.allocated.minor) > 0n ? <UnmatchAction transactionId={t.id} /> : null}
    </div>
  )
}

function UnmatchAction({ transactionId }: { transactionId: string }) {
  const matches = useQuery(orpc.matches.list.queryOptions({ input: { transactionId, status: 'active' } }))
  return (
    <>
      {matches.data?.items.map((m) => (
        <RequestAction
          key={m.id}
          label="Undo match"
          submitLabel="Request undo"
          submit={({ reason, idempotencyKey }) => client.matches.unmatch({ id: m.id, reason, idempotencyKey })}
        />
      ))}
    </>
  )
}
