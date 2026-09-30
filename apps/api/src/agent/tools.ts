import { createToolFactory } from '@orpc/ai-sdk'
import { agentProcedures, approvalPolicyOf, type AgentMeta } from '@paysync/contract'
import { tool, type ToolApprovalStatus, type ToolSet } from 'ai'
import { z } from 'zod'
import type { InitialContext } from '../orpc/base.js'
import { router } from '../orpc/router.js'
import { toolOutcome } from './outcome.js'

/** Who the agent acts for and what they asked, for one conversation. */
export interface AgentSessionContext {
  /** Everything the API needs to serve a call, minus how it arrived. */
  readonly services: Pick<InitialContext, 'auth' | 'db' | 'logger' | 'jev'>
  /** The person's own request headers (their session cookie): the agent acts as them, never as itself. */
  readonly headers: Headers
  readonly sessionId: string
  /** The person's latest request in their own words; Jev compares every write against it. */
  readonly userRequest: string | null
}

export interface AgentToolSet {
  readonly tools: ToolSet
  /** Chat-level confirmation (AI SDK human in the loop) before a destructive or money tool even files its request. */
  readonly toolApproval: Record<string, ToolApprovalStatus>
  readonly meta: ReadonlyMap<string, AgentMeta>
}

const OpenApiMeta = z.object({ '~openapi': z.object({ summary: z.string().optional(), description: z.string().optional() }).optional() })

function descriptionOf(meta: Readonly<Record<PropertyKey, unknown>>): string {
  const parsed = OpenApiMeta.safeParse(meta)
  const route = parsed.success ? parsed.data['~openapi'] : undefined
  return [route?.summary, route?.description].filter(Boolean).join('. ')
}

type RouterProcedure = Parameters<ReturnType<typeof createToolFactory<InitialContext>>>[0]

/**
 * The AI SDK surface (§9.4): one tool per procedure with agent metadata,
 * named and described from the contract. Calls run in-process through the
 * whole middleware stack as the person (§8.3 step 2), on the `ai-sdk`
 * surface, so the guard, Jev, budgets and approvals apply exactly as for MCP.
 */
export function agentTools(session: AgentSessionContext): AgentToolSet {
  const context: InitialContext = {
    ...session.services,
    surface: 'ai-sdk',
    agent: { sessionId: session.sessionId, userRequest: session.userRequest },
    reqHeaders: session.headers,
    resHeaders: new Headers(),
  }

  const tools: ToolSet = {}
  const toolApproval: Record<string, ToolApprovalStatus> = {}
  const meta = new Map<string, AgentMeta>()
  for (const p of agentProcedures<RouterProcedure>(router, 'ai-sdk')) {
    // The path is how permissions and the guard know which procedure this is (they fail closed without it).
    const createTool = createToolFactory<InitialContext>({ context, path: p.path.split('.') })
    const created = createTool(p.procedure, { description: descriptionOf(p.meta) })
    const execute = created.execute
    if (!execute) continue
    tools[p.agent.name] = tool({
      ...(created.description ? { description: created.description } : {}),
      inputSchema: created.inputSchema,
      execute: async (input, options) => {
        try {
          const output: unknown = await execute(input, options)
          return output
        } catch (error) {
          return toolOutcome(error)
        }
      },
    })
    meta.set(p.agent.name, p.agent)
    if (approvalPolicyOf(p.agent) === 'always') toolApproval[p.agent.name] = 'user-approval'
  }
  return { tools, toolApproval, meta }
}
