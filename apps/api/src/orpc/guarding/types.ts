import type { Db, Tx } from '@paysync/db'
import type { GuardPolicy } from '@paysync/guard'
import type { z } from 'zod'
import type { Caller, Surface } from '../base.js'

/** Domain failures of a guarded action, mapped to the procedure's typed errors. */
export class ActionError extends Error {
  readonly code: 'NOT_FOUND' | 'STALE_STATE' | 'INVALID_STATE' | 'ALLOCATION_REJECTED'
  readonly data: Record<string, unknown>

  constructor(code: ActionError['code'], message: string, data: Record<string, unknown> = {}) {
    super(message)
    this.name = 'ActionError'
    this.code = code
    this.data = data
  }
}

export interface Actor {
  readonly orgId: string
  readonly actorId: string
  readonly kind: Caller['kind']
}

export const actorOf = (caller: Caller): Actor => ({ orgId: caller.orgId, actorId: caller.actorId, kind: caller.kind })

export interface Checks {
  readonly blocks: readonly string[]
  readonly doubts: readonly string[]
}

export interface BudgetUse {
  readonly budget: string
  readonly limit: string
  readonly used: string
}

export type GuardedInput = {
  readonly idempotencyKey: string
  readonly dryRun?: boolean
} & Record<string, unknown>

/** A guarded write: the same `run` serves the direct call and the approved execution. */
export interface GuardedAction<I extends GuardedInput, R> {
  /** Contract path, e.g. "expected.void". */
  readonly procedure: string
  readonly result: z.ZodType<R>
  readonly isolation?: 'serializable'
  summary(tx: Tx, input: I): Promise<string>
  checks?(tx: Tx, input: I, caller: Caller, policy: GuardPolicy): Promise<Checks>
  /** The budget this request would exceed, or null. */
  overBudget?(tx: Tx, input: I, policy: GuardPolicy): Promise<BudgetUse | null>
  run(tx: Tx, input: I, actor: Actor): Promise<{ readonly result: R; readonly changed: boolean }>
}

export interface ApprovalRequiredData {
  pendingActionId: string
  summary: string
  approvalsRequired: number
  reasons: string[]
  preview: unknown
}

/** The typed-error constructors a guarded handler receives (a subset of each procedure's error map). */
export interface GuardErrors {
  APPROVAL_REQUIRED(options: { data: ApprovalRequiredData }): Error
  BLOCKED(options: { data: { reason: string } }): Error
  BUDGET_EXCEEDED(options: { data: BudgetUse }): Error
  RATE_LIMITED(): Error
  NOT_FOUND(): Error
  STALE_STATE?(options: { data: { currentVersion: number } }): Error
  INVALID_STATE?(options: { data: { status: string } }): Error
  ALLOCATION_REJECTED?(options: { data: { expectedPaymentId?: string; unallocated?: string; due?: string } }): Error
}

export interface GuardContext {
  readonly db: Db
  readonly caller: Caller
  readonly surface: Surface
  readonly policy?: GuardPolicy
}
