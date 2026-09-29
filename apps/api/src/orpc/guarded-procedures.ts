import { confirmMatch, requestReversal, unmatch, voidExpected, writeOffVariance } from './actions/index.js'
import { authed, type Caller, type Surface } from './base.js'
import { runGuarded, type GuardContext } from './guarding/index.js'
import type { Db } from '@paysync/db'

const guardContext = (context: { db: Db; caller: Caller; surface: Surface }): GuardContext => ({
  db: context.db,
  caller: context.caller,
  surface: context.surface,
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
