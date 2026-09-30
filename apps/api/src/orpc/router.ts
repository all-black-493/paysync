import { ReconException } from '@paysync/contract'
import { schema, withOrg } from '@paysync/db'
import { and, asc, count, desc, eq, gt, gte, inArray, lt, or, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { authed, os } from './base.js'
import { iso, normalizeReference, pageOf, toException, toExpectedPayment } from './mappers.js'
import { assistantChat } from '../agent/chat.js'
import { apiKeyProcedures } from './api-keys.js'
import { approvalProcedures, pendingActionProcedures } from './approvals/index.js'
import {
  exceptionsResolve,
  expectedCreate,
  expectedUpdate,
  expectedVoid,
  reversalsRequest,
  transactionsWriteOffVariance,
} from './guarded-procedures.js'
import { matchingProcedures } from './matching.js'
import { mutate } from './mutate.js'
import { allocatedByTransaction, listTransactions, selectExpected, toBigInt } from './queries.js'

const { allocation, exception, expectedPayment, match, mpesaTransaction, organization } = schema

const previewOf = <T extends z.ZodType>(item: T) => z.object({ dryRun: z.boolean(), changed: z.boolean(), result: item })

const me = authed.me.get.handler(async ({ context }) => {
  const [org] = await context.db
    .select({ id: organization.id, name: organization.name, slug: organization.slug })
    .from(organization)
    .where(eq(organization.id, context.caller.orgId))
  if (!org) throw new Error('active organization disappeared')
  const { caller } = context
  return {
    actor: { type: caller.kind, id: caller.actorId, name: caller.name, email: caller.email },
    organization: org,
    role: caller.role,
    permissions: context.permix.dehydrate(),
  }
})

const transactionsList = authed.transactions.list.handler(async ({ context, input }) =>
  withOrg(context.db, context.caller.orgId, async (tx) => {
    const allocatedTotal = sql`coalesce((SELECT sum(a.amount) FROM core.allocation a JOIN core.match m ON m.id = a.match_id
      WHERE a.transaction_id = ${mpesaTransaction.id} AND m.status = 'active'), 0)`
    const filters: Array<SQL | undefined> = [
      input.status ? eq(mpesaTransaction.status, input.status) : undefined,
      input.shortcodeId ? eq(mpesaTransaction.shortcodeId, input.shortcodeId) : undefined,
      input.from ? gte(mpesaTransaction.transactedAt, new Date(input.from)) : undefined,
      input.to ? lt(mpesaTransaction.transactedAt, new Date(input.to)) : undefined,
      input.cursor ? lt(mpesaTransaction.id, input.cursor) : undefined,
      input.allocated === 'none' ? sql`${allocatedTotal} = 0` : undefined,
      input.allocated === 'full' ? sql`${allocatedTotal} = ${mpesaTransaction.amount}` : undefined,
      input.allocated === 'partial'
        ? sql`${allocatedTotal} > 0 AND ${allocatedTotal} < ${mpesaTransaction.amount}`
        : undefined,
    ]
    return pageOf(await listTransactions(tx, and(...filters), input.limit + 1), input.limit)
  }),
)

const transactionsGet = authed.transactions.get.handler(async ({ context, input, errors }) =>
  withOrg(context.db, context.caller.orgId, async (tx) => {
    const [row] = await listTransactions(tx, eq(mpesaTransaction.id, input.id), 1)
    if (!row) throw errors.NOT_FOUND()
    return row
  }),
)

const expectedList = authed.expected.list.handler(async ({ context, input }) =>
  withOrg(context.db, context.caller.orgId, async (tx) => {
    const where = and(
      input.status ? eq(expectedPayment.status, input.status) : undefined,
      input.reference
        ? or(
            eq(expectedPayment.reference, input.reference),
            eq(expectedPayment.referenceNormalized, normalizeReference(input.reference)),
          )
        : undefined,
      input.cursor ? lt(expectedPayment.id, input.cursor) : undefined,
    )
    const rows = await selectExpected(tx, where, input.limit + 1)
    return pageOf(
      rows.map((r) => toExpectedPayment(r.row, r.paid)),
      input.limit,
    )
  }),
)

const expectedGet = authed.expected.get.handler(async ({ context, input, errors }) =>
  withOrg(context.db, context.caller.orgId, async (tx) => {
    const [found] = await selectExpected(tx, eq(expectedPayment.id, input.id), 1)
    if (!found) throw errors.NOT_FOUND()
    return toExpectedPayment(found.row, found.paid)
  }),
)

const exceptionsList = authed.exceptions.list.handler(async ({ context, input }) =>
  withOrg(context.db, context.caller.orgId, async (tx) => {
    const rows = await tx
      .select()
      .from(exception)
      .where(
        and(
          eq(exception.status, input.status),
          input.kind ? eq(exception.kind, input.kind) : undefined,
          input.cursor ? gt(exception.id, input.cursor) : undefined,
        ),
      )
      .orderBy(asc(exception.id))
      .limit(input.limit + 1)
    return pageOf(rows.map(toException), input.limit)
  }),
)

const exceptionsGet = authed.exceptions.get.handler(async ({ context, input, errors }) =>
  withOrg(context.db, context.caller.orgId, async (tx) => {
    const [row] = await tx.select().from(exception).where(eq(exception.id, input.id))
    if (!row) throw errors.NOT_FOUND()
    return toException(row)
  }),
)

const exceptionsAnnotate = authed.exceptions.annotate.handler(async ({ context, input, errors }) =>
  mutate({
    db: context.db,
    caller: context.caller,
    surface: context.surface,
    action: 'exceptions.annotate',
    input,
    output: previewOf(ReconException),
    run: async (tx) => {
      const [row] = await tx.select().from(exception).where(eq(exception.id, input.id)).for('update')
      if (!row) throw errors.NOT_FOUND()
      if (row.version !== input.version) throw errors.STALE_STATE({ data: { currentVersion: row.version } })
      const note = input.note === undefined ? row.note : input.note
      const tags = input.tags === undefined ? row.tags : [...new Set(input.tags)]
      const changed = note !== row.note || tags.join(',') !== row.tags.join(',')
      if (!changed) return { result: toException(row), changed: false }
      const [updated] = await tx
        .update(exception)
        .set({ note, tags, version: row.version + 1 })
        .where(eq(exception.id, row.id))
        .returning()
      if (!updated) throw new Error('update returned no row')
      return { result: toException(updated), changed: true }
    },
  }),
)

const matchesList = authed.matches.list.handler(async ({ context, input }) =>
  withOrg(context.db, context.caller.orgId, async (tx) => {
    const rows = await tx
      .select()
      .from(match)
      .where(
        and(
          input.transactionId ? eq(match.transactionId, input.transactionId) : undefined,
          input.status ? eq(match.status, input.status) : undefined,
          input.expectedPaymentId
            ? sql`EXISTS (SELECT 1 FROM core.allocation a WHERE a.match_id = ${match.id} AND a.expected_payment_id = ${input.expectedPaymentId})`
            : undefined,
          input.cursor ? lt(match.id, input.cursor) : undefined,
        ),
      )
      .orderBy(desc(match.id))
      .limit(input.limit + 1)
    const ids = rows.map((r) => r.id)
    const allocations =
      ids.length === 0 ? [] : await tx.select().from(allocation).where(inArray(allocation.matchId, ids))
    const items = rows.map((m) => ({
      id: m.id,
      transactionId: m.transactionId,
      method: m.method,
      status: m.status,
      confidence: m.confidence === null ? null : Number(m.confidence),
      allocations: allocations
        .filter((a) => a.matchId === m.id)
        .map((a) => ({ expectedPaymentId: a.expectedPaymentId, amount: { minor: a.amount.toString(), currency: 'KES' as const } })),
      createdAt: iso(m.createdAt),
    }))
    return pageOf(items, input.limit)
  }),
)

const EAT_OFFSET = '+03:00'

const dailySummary = authed.reports.dailySummary.handler(async ({ context, input }) =>
  withOrg(context.db, context.caller.orgId, async (tx) => {
    const start = new Date(`${input.date}T00:00:00${EAT_OFFSET}`)
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)
    const allocated = allocatedByTransaction(tx)
    const covered = sql`least(coalesce(${allocated.total}, 0), ${mpesaTransaction.amount})`
    const [totals] = await tx
      .select({
        count: count(),
        received: sql<string>`coalesce(sum(${mpesaTransaction.amount}), 0)`,
        matched: sql<string>`coalesce(sum(${covered}), 0)`,
        fullyMatched: sql<number>`count(*) FILTER (WHERE ${covered} = ${mpesaTransaction.amount})::int`,
      })
      .from(mpesaTransaction)
      .leftJoin(allocated, eq(allocated.transactionId, mpesaTransaction.id))
      .where(
        and(
          gte(mpesaTransaction.transactedAt, start),
          lt(mpesaTransaction.transactedAt, end),
          inArray(mpesaTransaction.status, ['pending_verification', 'verified']),
        ),
      )
    const [open] = await tx.select({ count: count() }).from(exception).where(eq(exception.status, 'open'))
    const received = toBigInt(totals?.received)
    const matched = toBigInt(totals?.matched)
    const receivedCount = totals?.count ?? 0
    const fullyMatched = totals?.fullyMatched ?? 0
    return {
      date: input.date,
      timezone: 'Africa/Nairobi' as const,
      received: { count: receivedCount, amount: { minor: received.toString(), currency: 'KES' as const } },
      matched: { count: fullyMatched, amount: { minor: matched.toString(), currency: 'KES' as const } },
      unmatched: {
        count: receivedCount - fullyMatched,
        amount: { minor: (received - matched).toString(), currency: 'KES' as const },
      },
      openExceptions: open?.count ?? 0,
    }
  }),
)

export const router = os.router({
  apiKeys: apiKeyProcedures,
  me: { get: me },
  transactions: { list: transactionsList, get: transactionsGet, writeOffVariance: transactionsWriteOffVariance },
  expected: { list: expectedList, get: expectedGet, create: expectedCreate, update: expectedUpdate, void: expectedVoid },
  exceptions: { list: exceptionsList, get: exceptionsGet, annotate: exceptionsAnnotate, resolve: exceptionsResolve },
  matches: { list: matchesList, ...matchingProcedures },
  reversals: { request: reversalsRequest },
  pendingActions: pendingActionProcedures,
  approvals: approvalProcedures,
  reports: { dailySummary },
  assistant: { chat: assistantChat },
})

export type Router = typeof router
