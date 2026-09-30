'use client'

import { useQuery } from '@tanstack/react-query'
import { exceptionStatus, humanize } from '../../lib/labels'
import { orpc } from '../../lib/orpc'
import { ExceptionWork, type ExceptionPermissions } from '../exceptions/exception-work'
import { LoadError, Loading } from '../ui/empty'
import { Status } from '../ui/status'
import { Time } from '../ui/time'
import { DetailSection, Facts } from './facts'
import { ExpectedRef, TransactionRef } from './refs'

export function ExceptionDetail({ id, can }: { id: string; can: ExceptionPermissions }) {
  const exception = useQuery(orpc.exceptions.get.queryOptions({ input: { id } }))
  if (exception.isPending) return <Loading label="Loading exception…" />
  if (exception.isError) return <LoadError what="this exception" />
  const item = exception.data

  return (
    <>
      <div className="detail-title">
        <Status status={exceptionStatus(item)} />
        <p className="detail-summary">{item.summary}</p>
      </div>
      <Facts
        items={[
          ['Status', humanize(item.status)],
          ['Priority', item.priority === 'high' ? 'High' : 'Normal'],
          ['Opened', <Time key="o" iso={item.createdAt} />],
          ['Last change', item.updatedAt === item.createdAt ? null : <Time key="u" iso={item.updatedAt} />],
          ['Payment', item.transactionId ? <TransactionRef key="t" id={item.transactionId} /> : null],
          ['Expected payment', item.expectedPaymentId ? <ExpectedRef key="e" id={item.expectedPaymentId} /> : null],
          ['Tags', item.tags.length > 0 ? item.tags.join(', ') : null],
        ]}
      />
      {item.note ? (
        <DetailSection title="Note">
          <p>{item.note}</p>
        </DetailSection>
      ) : null}
      <div className="stack">
        <ExceptionWork item={item} can={can} />
      </div>
    </>
  )
}
