import { schema, withOrg, type Tx } from '@paysync/db'
import { loadCandidates, readTransaction, suggest } from '@paysync/matching'
import { eq, inArray } from 'drizzle-orm'
import { authed } from './base.js'
import { matchesConfirm, matchesUnmatch } from './guarded-procedures.js'
import { toExpectedPayment, toTransaction } from './mappers.js'
import { paidByExpectedPayment, toBigInt } from './queries.js'

const { expectedPayment, mpesaTransaction, shortcode } = schema

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

export const matchingProcedures = { suggest: matchesSuggest, confirm: matchesConfirm, unmatch: matchesUnmatch }
