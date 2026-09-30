'use client'

import { useQuery } from '@tanstack/react-query'
import { orpc } from '../../lib/orpc'
import { RecordLink } from './record-link'

/** Links to related records, labelled the way people recognise them. */
export function ExpectedRef({ id }: { id: string }) {
  const expected = useQuery(orpc.expected.get.queryOptions({ input: { id } }))
  return (
    <RecordLink kind="expected" id={id} className="mono">
      {expected.data?.reference ?? 'Expected payment'}
    </RecordLink>
  )
}

export function TransactionRef({ id }: { id: string }) {
  const transaction = useQuery(orpc.transactions.get.queryOptions({ input: { id } }))
  return (
    <RecordLink kind="transaction" id={id} className="mono">
      {transaction.data?.receiptNumber ?? 'Payment'}
    </RecordLink>
  )
}
