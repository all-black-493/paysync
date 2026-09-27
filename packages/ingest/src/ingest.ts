import { createHash } from 'node:crypto'
import {
  C2BNotification,
  StkCallback,
  normalizeC2B,
  normalizeStkCallback,
  type DarajaEnvironment,
  type NormalizedPayment,
  type NormalizedStkCallback,
} from '@paysync/daraja'
import { enqueueJob, schema, withOrg, type Db, type Tx } from '@paysync/db'
import type { Logger, Sealer } from '@paysync/platform'
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { sealPayload } from './sealing.js'

const { exception, inboundEvent, mpesaTransaction, stkRequest, unroutedEvent } = schema

export interface IngestDeps {
  readonly db: Db
  readonly pii: Sealer
  readonly environment: DarajaEnvironment
  readonly logger: Logger
}

export type C2BSource = 'c2b_validation' | 'c2b_confirmation'
export type Source = (typeof schema.INBOUND_SOURCES)[number]
type UnroutedReason = (typeof schema.UNROUTED_REASONS)[number]

export interface IngestResult {
  readonly routed: boolean
  readonly duplicate: boolean
  /** Receipt of a transaction this delivery created, if any. */
  readonly createdReceipt: string | null
}

export const bodyHash = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`

export async function storeUnrouted(
  deps: IngestDeps,
  source: Source,
  externalId: string,
  reason: UnroutedReason,
  payload: unknown,
): Promise<IngestResult> {
  const inserted = await deps.db
    .insert(unroutedEvent)
    .values({ source, externalId, reason, payload: sealPayload(payload, deps.pii) })
    .onConflictDoNothing({ target: [unroutedEvent.source, unroutedEvent.externalId] })
    .returning({ id: unroutedEvent.id })
  deps.logger.warn({ source, reason, externalId }, 'callback stored as unrouted')
  return { routed: false, duplicate: inserted.length === 0, createdReceipt: null }
}

export function storeMalformed(deps: IngestDeps, source: Source, text: string): Promise<IngestResult> {
  return storeUnrouted(deps, source, bodyHash(text), 'malformed_json', { raw: text })
}

async function lookup<T extends z.ZodType>(db: Db, query: SQL, row: T): Promise<z.output<T> | undefined> {
  const { rows } = await db.execute(query)
  return rows.length === 0 ? undefined : row.parse(rows[0])
}

export async function insertEvent(
  tx: Tx,
  deps: Pick<IngestDeps, 'pii'>,
  values: { orgId: string; shortcodeId: string; source: Source; externalId: string; payload: unknown },
): Promise<string | null> {
  const [row] = await tx
    .insert(inboundEvent)
    .values({ ...values, payload: sealPayload(values.payload, deps.pii) })
    .onConflictDoNothing({ target: [inboundEvent.source, inboundEvent.externalId] })
    .returning({ id: inboundEvent.id })
  return row?.id ?? null
}

/**
 * At most one transaction per (shortcode, receipt), whichever delivery arrives
 * first. A new transaction is queued for verification in the same database
 * transaction.
 */
export async function insertTransaction(
  tx: Tx,
  deps: Pick<IngestDeps, 'pii'>,
  values: {
    orgId: string
    shortcodeId: string
    source: 'c2b' | 'stk' | 'pull'
    inboundEventId: string
    stkRequestId?: string
    payment: NormalizedPayment
  },
): Promise<string | null> {
  const { payment } = values
  const [row] = await tx
    .insert(mpesaTransaction)
    .values({
      orgId: values.orgId,
      shortcodeId: values.shortcodeId,
      receiptNumber: payment.receiptNumber,
      amount: payment.amountMinor,
      transactedAt: payment.transactedAt,
      source: values.source,
      billRefNumber: payment.billRefNumber,
      payerNameCiphertext: payment.payerName ? deps.pii.seal(payment.payerName) : null,
      msisdnCiphertext: payment.msisdn ? deps.pii.seal(payment.msisdn) : null,
      status: 'pending_verification',
      inboundEventId: values.inboundEventId,
      stkRequestId: values.stkRequestId,
    })
    .onConflictDoNothing({ target: [mpesaTransaction.shortcodeId, mpesaTransaction.receiptNumber] })
    .returning({ id: mpesaTransaction.id })
  if (!row) return null
  await enqueueJob(tx, 'verify_transaction', { orgId: values.orgId, transactionId: row.id }, { jobKey: `verify:${row.id}` })
  return row.id
}

const ShortcodeRoute = z.object({ shortcode_id: z.string(), org_id: z.string() })
const CheckoutRoute = z.object({ stk_request_id: z.string(), org_id: z.string(), shortcode_id: z.string() })
const TransIdOnly = z.object({ TransID: z.string().min(1).max(64) })
const CheckoutOnly = z.object({ Body: z.object({ stkCallback: z.object({ CheckoutRequestID: z.string().min(1).max(128) }) }) })

export async function ingestC2B(deps: IngestDeps, source: C2BSource, body: unknown): Promise<IngestResult> {
  const transId = TransIdOnly.safeParse(body)
  const fallbackId = transId.success ? transId.data.TransID : bodyHash(JSON.stringify(body))
  const parsed = C2BNotification.safeParse(body)
  if (!parsed.success) return storeUnrouted(deps, source, fallbackId, 'invalid_payload', body)

  let payment: NormalizedPayment
  try {
    payment = normalizeC2B(parsed.data)
  } catch {
    return storeUnrouted(deps, source, fallbackId, 'invalid_payload', body)
  }

  const target = await lookup(
    deps.db,
    sql`SELECT * FROM ingest.route_shortcode(${deps.environment}, ${parsed.data.BusinessShortCode})`,
    ShortcodeRoute,
  )
  if (!target) return storeUnrouted(deps, source, parsed.data.TransID, 'unknown_shortcode', body)

  return withOrg(deps.db, target.org_id, async (tx) => {
    const eventId = await insertEvent(tx, deps, {
      orgId: target.org_id,
      shortcodeId: target.shortcode_id,
      source,
      externalId: parsed.data.TransID,
      payload: body,
    })
    if (!eventId) return { routed: true, duplicate: true, createdReceipt: null }
    if (source === 'c2b_validation') return { routed: true, duplicate: false, createdReceipt: null }
    const created = await insertTransaction(tx, deps, {
      orgId: target.org_id,
      shortcodeId: target.shortcode_id,
      source: 'c2b',
      inboundEventId: eventId,
      payment,
    })
    return { routed: true, duplicate: false, createdReceipt: created ? payment.receiptNumber : null }
  })
}

const OPEN_STK_STATUSES = ['initiated', 'pending', 'unknown'] as const

export async function ingestStkCallback(deps: IngestDeps, body: unknown): Promise<IngestResult> {
  const checkout = CheckoutOnly.safeParse(body)
  const fallbackId = checkout.success ? checkout.data.Body.stkCallback.CheckoutRequestID : bodyHash(JSON.stringify(body))
  const parsed = StkCallback.safeParse(body)
  if (!parsed.success) return storeUnrouted(deps, 'stk_callback', fallbackId, 'invalid_payload', body)

  let normalized: NormalizedStkCallback
  try {
    normalized = normalizeStkCallback(parsed.data)
  } catch {
    return storeUnrouted(deps, 'stk_callback', fallbackId, 'invalid_payload', body)
  }

  const target = await lookup(
    deps.db,
    sql`SELECT * FROM ingest.route_stk_checkout(${normalized.checkoutRequestId})`,
    CheckoutRoute,
  )
  if (!target) return storeUnrouted(deps, 'stk_callback', normalized.checkoutRequestId, 'unknown_checkout', body)

  return withOrg(deps.db, target.org_id, async (tx) => {
    const eventId = await insertEvent(tx, deps, {
      orgId: target.org_id,
      shortcodeId: target.shortcode_id,
      source: 'stk_callback',
      externalId: normalized.checkoutRequestId,
      payload: body,
    })
    if (!eventId) return { routed: true, duplicate: true, createdReceipt: null }

    const [request] = await tx.select().from(stkRequest).where(eq(stkRequest.id, target.stk_request_id)).for('update')
    if (!request) throw new Error('routed STK request is not visible in its organization')
    if ((OPEN_STK_STATUSES as readonly string[]).includes(request.status)) {
      await tx
        .update(stkRequest)
        .set({
          status: normalized.outcome,
          resultCode: normalized.resultCode,
          resultDesc: normalized.resultDesc,
          version: request.version + 1,
        })
        .where(and(eq(stkRequest.id, request.id), inArray(stkRequest.status, [...OPEN_STK_STATUSES])))
    }
    if (normalized.outcome !== 'succeeded') return { routed: true, duplicate: false, createdReceipt: null }

    const payment = { ...normalized.payment, billRefNumber: request.accountReference }
    const transactionId = await insertTransaction(tx, deps, {
      orgId: target.org_id,
      shortcodeId: request.shortcodeId,
      source: 'stk',
      inboundEventId: eventId,
      stkRequestId: request.id,
      payment,
    })
    if (transactionId && payment.amountMinor !== request.amount) {
      await tx.insert(exception).values({
        orgId: target.org_id,
        kind: 'amount_mismatch',
        priority: 'high',
        summary: `STK payment ${payment.receiptNumber} differs from the amount requested`,
        transactionId,
        dedupeKey: `amount_mismatch:${transactionId}`,
        details: { requestedMinor: request.amount.toString(), receivedMinor: payment.amountMinor.toString() },
      })
    }
    return { routed: true, duplicate: false, createdReceipt: transactionId ? payment.receiptNumber : null }
  })
}
