import { confirmMatch, requestReversal, unmatch, voidExpected, writeOffVariance } from './actions/index.js'
import { authed, type Caller, type InitialContext } from './base.js'
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
