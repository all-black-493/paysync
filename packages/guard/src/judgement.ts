import type { Intent } from '@paysync/decisions'

/** What Jev said about one agent action, or why it could not say (§8.3 step 7). */
export type Judgement =
  | {
      readonly kind: 'answered'
      readonly intent: Intent
      readonly intentConfidence: number
      readonly injection: number
      readonly scope: number
    }
  | { readonly kind: 'unavailable'; readonly reason: string }

export interface JudgementThresholds {
  /** Above this, the input or data is trying to steer the agent: block. */
  readonly injectionBlock: number
  /** Above this, the action reaches further than asked: a person approves. */
  readonly scopeApproval: number
  /** Below this intent confidence (or any intent but matches_request): a person approves. */
  readonly intentConfidence: number
}

const percent = (p: number) => `${String(Math.round(p * 100))}%`

export function injectionFound(judgement: Judgement | undefined, t: JudgementThresholds): string | null {
  if (judgement?.kind !== 'answered' || judgement.injection <= t.injectionBlock) return null
  return `the request or its data carries instructions aimed at the agent (Jev ${percent(judgement.injection)})`
}

/** Reasons Jev gives for a person to look; empty when it is satisfied. Failing to answer is itself a reason (fail closed). */
export function judgementDoubts(judgement: Judgement | undefined, t: JudgementThresholds): string[] {
  if (!judgement) return []
  if (judgement.kind === 'unavailable') return [`Jev could not judge this action (${judgement.reason})`]
  const doubts: string[] = []
  if (judgement.scope > t.scopeApproval) doubts.push(`it may reach further than the request (Jev ${percent(judgement.scope)})`)
  if (judgement.intent !== 'matches_request') doubts.push(`Jev reads it as ${judgement.intent.replaceAll('_', ' ')}`)
  else if (judgement.intentConfidence < t.intentConfidence) doubts.push(`Jev is unsure it is what was asked (${percent(judgement.intentConfidence)})`)
  return doubts
}
