import {
  confirmMatch,
  createExpected,
  findByReference,
  isDuplicateReference,
  requestReversal,
  resolveException,
  unmatch,
  updateExpected,
  voidExpected,
  writeOffVariance,
} from './actions/index.js'
import { withOrg } from '@paysync/db'
import { authed, type Caller, type InitialContext } from './base.js'
import { normalizeReference } from './mappers.js'
import { runGuarded, type GuardContext } from './guarding/index.js'

const guardContext = (context: InitialContext & { caller: Caller }): GuardContext => ({
  db: context.db,
  caller: context.caller,
  surface: context.surface,
  jev: context.jev,
  ...(context.agent ? { agent: context.agent } : {}),
})

export const matchesConfirm = authed.matches.confirm.handler(({ context, input, errors }) =>
  runGuarded(guardContext(context), confirmMatch, input, errors),
)

export const matchesUnmatch = authed.matches.unmatch.handler(({ context, input, errors }) =>
  runGuarded(guardContext(context), unmatch, input, errors),
)

export const expectedVoid = authed.expected.void.handler(({ context, input, errors }) =>
  runGuarded(guardContext(context), voidExpected, input, errors),
)

export const transactionsWriteOffVariance = authed.transactions.writeOffVariance.handler(({ context, input, errors }) =>
  runGuarded(guardContext(context), writeOffVariance, input, errors),
)

export const reversalsRequest = authed.reversals.request.handler(({ context, input, errors }) =>
  runGuarded(guardContext(context), requestReversal, input, errors),
)

export const expectedCreate = authed.expected.create.handler(({ context, input, errors }) =>
  runGuarded(guardContext(context), createExpected, input, errors).catch(async (error: unknown) => {
    // Lost a race to the unique reference: answer with the one that won.
    if (isDuplicateReference(error)) {
      const existing = await withOrg(context.db, context.caller.orgId, (tx) => findByReference(tx, normalizeReference(input.reference)))
      if (existing) throw errors.DUPLICATE_REFERENCE({ data: { existingId: existing.id } })
    }
    throw error
  }),
)

export const expectedUpdate = authed.expected.update.handler(({ context, input, errors }) =>
  runGuarded(guardContext(context), updateExpected, input, errors).catch((error: unknown) => {
    if (isDuplicateReference(error)) throw errors.DUPLICATE_REFERENCE({ data: { existingId: input.id } })
    throw error
  }),
)

export const exceptionsResolve = authed.exceptions.resolve.handler(({ context, input, errors }) =>
  runGuarded(guardContext(context), resolveException, input, errors),
)
