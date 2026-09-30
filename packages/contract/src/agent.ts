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

export interface ListedProcedure<P> {
  /** Dotted contract path, e.g. "matches.confirm". */
  readonly path: string
  readonly meta: Readonly<Record<PropertyKey, unknown>>
  /** The node itself: a contract procedure, or an implemented one when walking a router. */
  readonly procedure: P
}

function isProcedure(node: unknown): node is { '~orpc': { meta: Record<PropertyKey, unknown> } } {
  if (typeof node !== 'object' || node === null || !('~orpc' in node)) return false
  const internals: unknown = node['~orpc']
  return typeof internals === 'object' && internals !== null && 'meta' in internals && typeof internals.meta === 'object' && internals.meta !== null
}

/** Every procedure in a contract or router, depth first, with its path and meta. */
export function listProcedures<P = unknown>(node: unknown, prefix: readonly string[] = []): Array<ListedProcedure<P>> {
  if (isProcedure(node)) return [{ path: prefix.join('.'), meta: node['~orpc'].meta, procedure: node as P }]
  if (typeof node !== 'object' || node === null) return []
  return Object.entries(node).flatMap(([key, child]) => listProcedures<P>(child, [...prefix, key]))
}

/** The procedures an agent surface may turn into tools (§8.1: no meta, no tool). */
export function agentProcedures<P = unknown>(node: unknown, surface: 'ai-sdk' | 'mcp'): Array<ListedProcedure<P> & { readonly agent: AgentMeta }> {
  return listProcedures<P>(node).flatMap((p) => {
    const meta = agentMetaOf(p.meta)
    return meta && (meta.exposeTo ?? ['ai-sdk', 'mcp']).includes(surface) ? [{ ...p, agent: meta }] : []
  })
}
