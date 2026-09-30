'use client'

import type { ExceptionOutput } from '@paysync/contract'
import { useQuery } from '@tanstack/react-query'
import { exceptionStatus } from '../../lib/labels'
import { orpc } from '../../lib/orpc'
import { RecordLink } from '../detail/record-link'
import { Empty, LoadError, Loading } from '../ui/empty'
import { Status } from '../ui/status'
import { Time } from '../ui/time'
import { ExceptionWork, type ExceptionPermissions } from './exception-work'

export function ExceptionsPanel({ can }: { can: ExceptionPermissions }) {
  const list = useQuery(orpc.exceptions.list.queryOptions({ input: {} }))
  if (list.isPending) return <Loading label="Loading exceptions…" />
  if (list.isError) return <LoadError what="exceptions" />
  if (list.data.items.length === 0) {
    return <Empty title="Everything is reconciled.">New payments that cannot be matched with confidence will wait here.</Empty>
  }
  return (
    <ul className="records" aria-label="Open exceptions">
      {list.data.items.map((item) => (
        <ExceptionRow key={item.id} item={item} can={can} />
      ))}
    </ul>
  )
}

function ExceptionRow({ item, can }: { item: ExceptionOutput; can: ExceptionPermissions }) {
  return (
    <li className="record clickable">
      <div className="record-kind">
        <Status status={exceptionStatus(item)} />
      </div>
      <div className="record-body">
        <RecordLink kind="exception" id={item.id} stretch className="record-title">
          {item.summary}
        </RecordLink>
        <p className="record-meta">
          Opened <Time iso={item.createdAt} />
          {item.tags.length > 0 ? ` · ${item.tags.join(', ')}` : ''}
        </p>
        {item.note ? (
          <p className="record-note">
            <span className="label">Note</span>
            {item.note}
          </p>
        ) : null}
      </div>
      <ExceptionWork item={item} can={can} />
    </li>
  )
}
