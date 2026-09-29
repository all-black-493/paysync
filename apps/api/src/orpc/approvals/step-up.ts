import type { GuardPolicy } from '@paysync/guard'
import type { Caller, Surface } from '../base.js'

export type StepUpProblem = 'not_web' | 'two_factor_required' | 'session_too_old'

/**
 * Who may decide (§6C.4, §8.4): a person in the web app with two-factor
 * authentication who signed in recently. Roles are checked by Permix.
 */
export function stepUpProblem(caller: Caller, surface: Surface, policy: GuardPolicy, now = Date.now()): StepUpProblem | null {
  if (surface !== 'web' || caller.kind !== 'user' || !caller.session) return 'not_web'
  if (!caller.session.twoFactorEnabled) return 'two_factor_required'
  if (now - caller.session.createdAt.getTime() > policy.stepUpMaxAgeMs) return 'session_too_old'
  return null
}
