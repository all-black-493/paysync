'use client'

import { useQuery } from '@tanstack/react-query'
import { orpc } from '../../lib/orpc'
import { RequestBody, type Viewer } from '../approvals/request-card'
import { LoadError, Loading } from '../ui/empty'
import { DetailSection } from './facts'
import { ExpectedRef, TransactionRef } from './refs'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function field(input: unknown, name: string): string | null {
  if (!isRecord(input)) return null
  const value = input[name]
  return typeof value === 'string' ? value : null
}

/** The record the request acts on, when the request names one directly. */
function Affected({ procedure, input }: { procedure: string; input: unknown }) {
  const transactionId = field(input, 'transactionId')
  const id = field(input, 'id')
  const link = transactionId ? <TransactionRef id={transactionId} /> : procedure === 'expected.void' && id ? <ExpectedRef id={id} /> : null
  if (!link) return null
  return (
    <DetailSection title="Acts on">
      <p>{link}</p>
    </DetailSection>
  )
}

export function RequestDetail({ id, viewer }: { id: string; viewer: Viewer }) {
  const request = useQuery(orpc.pendingActions.get.queryOptions({ input: { id } }))
  if (request.isPending) return <Loading label="Loading request…" />
  if (request.isError) return <LoadError what="this request" />
  const action = request.data
  const reason = field(action.input, 'reason')

  return (
    <>
      <div className="request request-stacked" data-money={action.money}>
        <RequestBody action={action} viewer={viewer} />
      </div>
      {reason ? (
        <DetailSection title="Reason given">
          <p>{reason}</p>
        </DetailSection>
      ) : null}
      <Affected procedure={action.procedure} input={action.input} />
    </>
  )
}
