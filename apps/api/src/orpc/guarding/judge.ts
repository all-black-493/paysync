import { JevError, judgeAction } from '@paysync/decisions'
import type { GuardPolicy, Judgement } from '@paysync/guard'
import type { GuardContext, GuardedInput } from './types.js'

export interface Judged {
  readonly judgement: Judgement
  /** Question answers, probabilities and latency for the audit log (§8.5). */
  readonly evidence: Record<string, unknown>
}

/**
 * §8.3 step 7 for one agent action, outside any database transaction. Every
 * failure, including a slow answer, is `unavailable`, which the guard turns
 * into a person's approval.
 */
export async function judge(
  context: GuardContext,
  procedure: string,
  summary: string,
  input: GuardedInput,
  records: unknown,
  policy: GuardPolicy,
): Promise<Judged> {
  const args = Object.fromEntries(Object.entries(input).filter(([name]) => name !== 'idempotencyKey' && name !== 'dryRun'))
  try {
    const answer = await judgeAction(
      context.jev,
      { userRequest: context.agent?.userRequest ?? null, procedure, summary, input: args, records },
      { timeoutMs: policy.jev.timeoutMs },
    )
    return {
      judgement: { kind: 'answered', intent: answer.intent.choice, intentConfidence: answer.intent.confidence, injection: answer.injection, scope: answer.scope },
      evidence: { model: answer.model, latencyMs: answer.latencyMs, intent: answer.intent, injection: answer.injection, scope: answer.scope },
    }
  } catch (error) {
    if (!(error instanceof JevError)) throw error
    return { judgement: { kind: 'unavailable', reason: error.kind }, evidence: { failure: error.kind } }
  }
}
