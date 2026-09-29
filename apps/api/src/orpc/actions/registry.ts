import type { Tx } from '@paysync/db'
import type { GuardPolicy } from '@paysync/guard'
import type { Actor, BudgetUse, GuardedAction, GuardedInput } from '../guarding/index.js'
import { confirmMatch } from './confirm-match.js'
import { requestReversal } from './request-reversal.js'
import { unmatch } from './unmatch.js'
import { voidExpected } from './void-expected.js'
import { writeOffVariance } from './write-off-variance.js'

/** A guarded action with its input type erased, for running stored (re-validated) requests. */
export interface Executable {
  overBudget(tx: Tx, input: unknown, policy: GuardPolicy): Promise<BudgetUse | null>
  run(tx: Tx, input: unknown, actor: Actor): Promise<{ readonly result: unknown; readonly changed: boolean }>
}

function executable<I extends GuardedInput, R>(action: GuardedAction<I, R>): Executable {
  // The stored input was validated by the procedure's own schemas before this runs.
  const asInput = (value: unknown) => value as I
  return {
    overBudget: async (tx, input, policy) => (await action.overBudget?.(tx, asInput(input), policy)) ?? null,
    run: (tx, input, actor) => action.run(tx, asInput(input), actor),
  }
}

/** Everything that can wait in the approval queue, by procedure. */
export const APPROVABLE: Readonly<Record<string, Executable>> = {
  [confirmMatch.procedure]: executable(confirmMatch),
  [unmatch.procedure]: executable(unmatch),
  [voidExpected.procedure]: executable(voidExpected),
  [writeOffVariance.procedure]: executable(writeOffVariance),
  [requestReversal.procedure]: executable(requestReversal),
}
