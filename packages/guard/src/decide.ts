import { approvalPolicyOf, type AgentMeta } from '@paysync/contract'

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
}

export type GuardDecision =
  | { readonly kind: 'allow'; readonly reasons: readonly string[] }
  | { readonly kind: 'require_approval'; readonly approvalsRequired: 1 | 2; readonly reasons: readonly string[] }
  | { readonly kind: 'block'; readonly reasons: readonly string[] }

const AGENT_SURFACES = new Set<GuardSurface>(['ai-sdk', 'mcp'])

/**
 * The static guard (AGENTS.md §8.3 steps 1, 5, 6 and 8; Jev joins in M6).
 * Fails closed: an agent calling something without agent metadata is blocked.
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

  const policy = approvalPolicyOf(meta)
  const approvalsRequired: 1 | 2 = meta.money && request.production ? 2 : (meta.approvers ?? 1)
  if (policy === 'always') {
    return {
      kind: 'require_approval',
      approvalsRequired,
      reasons: [meta.money ? 'moves money: always needs approval' : 'destructive: always needs approval', ...checks.doubts],
    }
  }
  if (policy === 'on-doubt' && request.actor === 'machine' && checks.doubts.length > 0) {
    return { kind: 'require_approval', approvalsRequired, reasons: [...checks.doubts] }
  }
  return { kind: 'allow', reasons: [] }
}
