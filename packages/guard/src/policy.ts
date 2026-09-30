import type { JudgementThresholds } from './judgement.js'

/** Guard limits (AGENTS.md §8.3). Per-organization overrides come later with config/policy. */
export interface GuardPolicy {
  /** Largest variance one write-off may clear, in minor units. */
  readonly writeOffCapMinor: bigint
  /** Total written off per organization per day (EAT). */
  readonly writeOffDailyBudgetMinor: bigint
  /** Reversals requested per organization per day (EAT). */
  readonly reversalDailyBudget: number
  /** Writes per caller per minute. */
  readonly writesPerMinute: number
  /** An approval request not decided within this expires. */
  readonly approvalTtlMs: number
  /** Approvers must have signed in this recently (§6C.4 step-up). */
  readonly stepUpMaxAgeMs: number
  /** Jev's judgement of agent actions (§8.3 step 7); slower than this counts as no answer. */
  readonly jev: JudgementThresholds & { readonly timeoutMs: number }
}

export const DEFAULT_GUARD_POLICY: GuardPolicy = {
  writeOffCapMinor: 500_00n,
  writeOffDailyBudgetMinor: 2_000_00n,
  reversalDailyBudget: 5,
  writesPerMinute: 60,
  approvalTtlMs: 72 * 60 * 60_000,
  stepUpMaxAgeMs: 10 * 60_000,
  jev: { injectionBlock: 0.2, scopeApproval: 0.3, intentConfidence: 0.8, timeoutMs: 800 },
}
