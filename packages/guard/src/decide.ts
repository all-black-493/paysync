import { approvalPolicyOf, type AgentMeta } from '@paysync/contract'
import { injectionFound, judgementDoubts, type Judgement, type JudgementThresholds } from './judgement.js'
import { DEFAULT_GUARD_POLICY } from './policy.js'

export type GuardSurface = 'web' | 'rest' | 'ai-sdk' | 'mcp'

export interface GuardRequest {
  /** The procedure's agent metadata; undefined = not an agent tool. */
  readonly meta: AgentMeta | undefined
  readonly surface: GuardSurface
  /** A person with a session, or a machine (API key, agent). */
  readonly actor: 'person' | 'machine'
  /** Deterministic checks (§8.3 step 6). */
  readonly checks: {
    /** Rules this request breaks: never allowed, whatever approves it. */
    readonly blocks: readonly string[]
    /** Reasons a machine request needs a person to look. */
    readonly doubts: readonly string[]
  }
  readonly production: boolean
  /** Jev's view of an agent action; absent when Jev was not asked (people, reads). */
  readonly judgement?: Judgement
  readonly thresholds?: JudgementThresholds
}

export type GuardDecision =
  | { readonly kind: 'allow'; readonly reasons: readonly string[] }
  | { readonly kind: 'require_approval'; readonly approvalsRequired: 1 | 2; readonly reasons: readonly string[] }
  | { readonly kind: 'block'; readonly reasons: readonly string[] }

const AGENT_SURFACES = new Set<GuardSurface>(['ai-sdk', 'mcp'])

/** Jev judges agent calls that change something (§8.3 step 7); people and reads are not asked. */
export function needsJudgement(meta: AgentMeta | undefined, surface: GuardSurface): boolean {
  return meta !== undefined && AGENT_SURFACES.has(surface) && approvalPolicyOf(meta) !== 'never'
}

/**
 * The guard's decision (AGENTS.md §8.3 steps 1 and 5–8). Fails closed: an
 * agent calling something without agent metadata is blocked, and Jev can only
 * tighten a decision (block, or ask a person), never loosen one.
 */
export function decide(request: GuardRequest): GuardDecision {
  const { meta, surface, checks } = request

  if (AGENT_SURFACES.has(surface)) {
    if (!meta) return { kind: 'block', reasons: ['not available to agents'] }
    const exposed = meta.exposeTo ?? ['ai-sdk', 'mcp']
    if (!exposed.includes(surface as 'ai-sdk' | 'mcp')) return { kind: 'block', reasons: [`not available on ${surface}`] }
  }

  if (checks.blocks.length > 0) return { kind: 'block', reasons: [...checks.blocks] }
  if (!meta) return { kind: 'allow', reasons: [] }

  const thresholds = request.thresholds ?? DEFAULT_GUARD_POLICY.jev
  const injection = injectionFound(request.judgement, thresholds)
  if (injection) return { kind: 'block', reasons: [injection] }
  const jevDoubts = judgementDoubts(request.judgement, thresholds)

  const policy = approvalPolicyOf(meta)
  const approvalsRequired: 1 | 2 = meta.money && request.production ? 2 : (meta.approvers ?? 1)
  if (policy === 'always') {
    return {
      kind: 'require_approval',
      approvalsRequired,
      reasons: [meta.money ? 'moves money: always needs approval' : 'destructive: always needs approval', ...checks.doubts, ...jevDoubts],
    }
  }
  const doubts = request.actor === 'machine' ? [...checks.doubts, ...jevDoubts] : []
  if (policy === 'on-doubt' && doubts.length > 0) {
    return { kind: 'require_approval', approvalsRequired, reasons: doubts }
  }
  return { kind: 'allow', reasons: [] }
}
