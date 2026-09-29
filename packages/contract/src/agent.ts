/** How agents may use a procedure (AGENTS.md §8.1). No meta = never an agent tool. */
export interface AgentMeta {
  /** Stable tool name for AI SDK and MCP. */
  readonly name: string
  readonly risk: 'read' | 'write' | 'destructive'
  /** Moves or reverses money. */
  readonly money?: boolean
  /** Defaults: read → never, write → on-doubt, destructive or money → always. */
  readonly approval?: 'never' | 'on-doubt' | 'always'
  readonly approvers?: 1 | 2
  readonly budget?: 'writeoffs' | 'reversals'
  /** Default: both. */
  readonly exposeTo?: ReadonlyArray<'ai-sdk' | 'mcp'>
}

export const AGENT_META_KEY = '~agent'

/** oRPC v2 meta initializer, used as `.meta(agent({...}))` next to `openapi(...)`. */
export function agent(meta: AgentMeta) {
  return {
    name: AGENT_META_KEY,
    init: (current: Record<PropertyKey, unknown>) => ({ ...current, [AGENT_META_KEY]: meta }),
  }
}

export function agentMetaOf(meta: Readonly<Record<PropertyKey, unknown>>): AgentMeta | undefined {
  const value = meta[AGENT_META_KEY]
  return typeof value === 'object' && value !== null && 'name' in value && 'risk' in value ? (value as AgentMeta) : undefined
}

export function approvalPolicyOf(meta: AgentMeta): 'never' | 'on-doubt' | 'always' {
  if (meta.money) return 'always'
  if (meta.approval) return meta.approval
  return meta.risk === 'read' ? 'never' : meta.risk === 'write' ? 'on-doubt' : 'always'
}
