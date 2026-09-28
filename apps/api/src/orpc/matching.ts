import { Match, ReconException, fromMoney } from '@paysync/contract'
import { schema, withOrg, type Tx } from '@paysync/db'
import { MatchError, applyMatch, loadCandidates, readTransaction, resolveMatchExceptions, suggest } from '@paysync/matching'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { authed } from './base.js'
import { iso, toException, toExpectedPayment, toTransaction } from './mappers.js'
import { mutate } from './mutate.js'
import { paidByExpectedPayment, toBigInt } from './queries.js'

const { allocation, exception, expectedPayment, match, mpesaTransaction, shortcode } = schema

const previewOf = <T extends z.ZodType>(item: T) => z.object({ dryRun: z.boolean(), changed: z.boolean(), result: item })

async function loadTransaction(tx: Tx, transactionId: string) {
  const [row] = await tx
    .select({ t: mpesaTransaction, s: { id: shortcode.id, code: shortcode.code, kind: shortcode.kind } })
    .from(mpesaTransaction)
    .innerJoin(shortcode, eq(shortcode.id, mpesaTransaction.shortcodeId))
    .where(eq(mpesaTransaction.id, transactionId))
  return row
}

async function toMatchOutput(tx: Tx, matchId: string) {
  const [m] = await tx.select().from(match).where(eq(match.id, matchId))
  if (!m) throw new Error('match not visible after insert')
  const parts = await tx.select().from(allocation).where(eq(allocation.matchId, m.id))
  return {
    id: m.id,
    transactionId: m.transactionId,
    method: m.method,
    status: m.status,
    confidence: m.confidence === null ? null : Number(m.confidence),
    allocations: parts.map((a) => ({ expectedPaymentId: a.expectedPaymentId, amount: { minor: a.amount.toString(), currency: 'KES' as const } })),
    createdAt: iso(m.createdAt),
  }
}

const matchesSuggest = authed.matches.suggest.handler(async ({ context, input, errors }) =>
  withOrg(context.db, context.caller.orgId, async (tx) => {
    const found = await loadTransaction(tx, input.transactionId)
    if (!found) throw errors.NOT_FOUND()
    const payment = await readTransaction(tx, input.transactionId)
    if (!payment) throw errors.NOT_FOUND()
    const ranked = suggest(payment, await loadCandidates(tx))
    const paid = paidByExpectedPayment(tx)
    const rows =
      ranked.length === 0
        ? []
        : await tx
            .select({ e: expectedPayment, paid: paid.total })
            .from(expectedPayment)
            .leftJoin(paid, eq(paid.expectedPaymentId, expectedPayment.id))
            .where(inArray(expectedPayment.id, ranked.map((r) => r.expectedPaymentId)))
    const byId = new Map(rows.map((r) => [r.e.id, toExpectedPayment(r.e, toBigInt(r.paid))]))
    return {
      transaction: toTransaction(found.t, found.s, payment.allocated),
      suggestions: ranked.flatMap((r) => {
        const expected = byId.get(r.expectedPaymentId)
        return expected
          ? [{ expectedPayment: expected, score: r.score, reasons: [...r.reasons], amount: { minor: r.amount.toString(), currency: 'KES' as const } }]
          : []
      }),
    }
  }),
)

const matchesConfirm = authed.matches.confirm.handler(async ({ context, input, errors }) =>
  mutate({
    db: context.db,
    caller: context.caller,
    surface: context.surface,
    action: 'matches.confirm',
    input,
    output: previewOf(Match),
    isolation: 'serializable',
    run: async (tx) => {
      let matchId: string
      try {
        ;({ matchId } = await applyMatch(tx, {
          orgId: context.caller.orgId,
          transactionId: input.transactionId,
          expectedVersion: input.version,
          method: 'manual',
          parts: input.allocations.map((a) => ({ expectedPaymentId: a.expectedPaymentId, amount: fromMoney(a.amount) })),
          actorUserId: context.caller.kind === 'user' ? context.caller.actorId : null,
          createdBy: `${context.caller.kind}:${context.caller.actorId}`,
        }))
      } catch (error) {
        if (!(error instanceof MatchError)) throw error
        switch (error.code) {
          case 'NOT_FOUND':
            throw errors.NOT_FOUND()
          case 'STALE_STATE':
            throw errors.STALE_STATE({ data: { currentVersion: Number(error.details.currentVersion) } })
          case 'NOT_VERIFIED':
          case 'EXPECTED_CLOSED':
            throw errors.INVALID_STATE({ data: { status: error.details.status ?? error.code } })
          case 'EXCEEDS_DUE':
          case 'EXCEEDS_AMOUNT':
            throw errors.ALLOCATION_REJECTED({
              data: {
                ...(error.details.expectedPaymentId ? { expectedPaymentId: error.details.expectedPaymentId } : {}),
                ...(error.details.unallocatedMinor ? { unallocated: error.details.unallocatedMinor } : {}),
                ...(error.details.dueMinor ? { due: error.details.dueMinor } : {}),
              },
            })
        }
      }
      await resolveMatchExceptions(tx, input.transactionId, 'Matched by hand.')
      return { changed: true, result: await toMatchOutput(tx, matchId) }
    },
  }),
)

const exceptionsResolve = authed.exceptions.resolve.handler(async ({ context, input, errors }) =>
  mutate({
    db: context.db,
    caller: context.caller,
    surface: context.surface,
    action: 'exceptions.resolve',
    input,
    output: previewOf(ReconException),
    run: async (tx) => {
      const [row] = await tx.select().from(exception).where(eq(exception.id, input.id)).for('update')
      if (!row) throw errors.NOT_FOUND()
      if (row.version !== input.version) throw errors.STALE_STATE({ data: { currentVersion: row.version } })
      if (row.status !== 'open') throw errors.INVALID_STATE({ data: { status: row.status } })
      const [updated] = await tx
        .update(exception)
        .set({ status: input.resolution, note: input.note, resolvedAt: sql`now()`, version: row.version + 1 })
        .where(and(eq(exception.id, row.id), eq(exception.status, 'open')))
        .returning()
      if (!updated) throw new Error('update returned no row')
      return { changed: true, result: toException(updated) }
    },
  }),
)

export const matchingProcedures = { suggest: matchesSuggest, confirm: matchesConfirm }
export { exceptionsResolve }
