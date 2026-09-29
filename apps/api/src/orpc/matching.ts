import { ReconException } from '@paysync/contract'
import { schema, withOrg, type Tx } from '@paysync/db'
import { loadCandidates, readTransaction, suggest } from '@paysync/matching'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { authed } from './base.js'
import { matchesConfirm, matchesUnmatch } from './guarded-procedures.js'
import { toException, toExpectedPayment, toTransaction } from './mappers.js'
import { mutate } from './mutate.js'
import { paidByExpectedPayment, toBigInt } from './queries.js'

const { exception, expectedPayment, mpesaTransaction, shortcode } = schema

const previewOf = <T extends z.ZodType>(item: T) => z.object({ dryRun: z.boolean(), changed: z.boolean(), result: item })

async function loadTransaction(tx: Tx, transactionId: string) {
  const [row] = await tx
    .select({ t: mpesaTransaction, s: { id: shortcode.id, code: shortcode.code, kind: shortcode.kind } })
    .from(mpesaTransaction)
    .innerJoin(shortcode, eq(shortcode.id, mpesaTransaction.shortcodeId))
    .where(eq(mpesaTransaction.id, transactionId))
  return row
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
      transaction: toTransaction(found.t, found.s, payment.allocations, payment.writtenOff),
      suggestions: ranked.flatMap((r) => {
        const expected = byId.get(r.expectedPaymentId)
        return expected
          ? [{ expectedPayment: expected, score: r.score, reasons: [...r.reasons], amount: { minor: r.amount.toString(), currency: 'KES' as const } }]
          : []
      }),
    }
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

export const matchingProcedures = { suggest: matchesSuggest, confirm: matchesConfirm, unmatch: matchesUnmatch }
export { exceptionsResolve }
