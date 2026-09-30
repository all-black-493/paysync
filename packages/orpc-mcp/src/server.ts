import {
  McpServer,
  fromJsonSchema,
  requireScopes,
  type CallToolResult,
  type Implementation,
  type McpRequestContext,
  type McpServerFactory,
  type ToolAnnotations,
} from '@modelcontextprotocol/server'
import { call, type AnyProcedure } from '@orpc/server'
import type { JsonSchema } from './schema.js'

/** One MCP tool backed by one oRPC procedure. */
export interface ProcedureTool {
  /** Stable tool name; clients cache it and models are prompted with it. */
  readonly name: string
  readonly title?: string
  /** Written for an agent reader. Never built from data a stranger typed. */
  readonly description: string
  /** Strict JSON Schema for the arguments (see `strictJsonSchema`). */
  readonly inputSchema: JsonSchema
  readonly annotations?: ToolAnnotations
  /** OAuth scopes the token must carry for this tool; clients get a step-up challenge otherwise. */
  readonly requiredScopes?: readonly [string, ...string[]]
  readonly procedure: AnyProcedure
  /** The procedure's router path; middleware keyed on the path (permissions, guards) needs it. */
  readonly path: readonly string[]
}

export interface OrpcMcpOptions<TContext> {
  readonly info: Implementation
  readonly instructions?: string
  readonly tools: readonly ProcedureTool[]
  /** The oRPC initial context for one MCP request, built at most once and only when a tool runs. */
  readonly context: (request: McpRequestContext) => TContext | Promise<TContext>
  /** A thrown error as a tool result the model can read. Must not leak internals. */
  readonly onError: (error: unknown, tool: ProcedureTool) => CallToolResult
  /** Prepended to every successful result, e.g. to mark third-party text as data. */
  readonly resultNote?: string
}

function successResult(output: unknown, note: string | undefined): CallToolResult {
  const json = JSON.stringify(output ?? null)
  const content: CallToolResult['content'] = note ? [{ type: 'text', text: note }, { type: 'text', text: json }] : [{ type: 'text', text: json }]
  return typeof output === 'object' && output !== null && !Array.isArray(output)
    ? { content, structuredContent: output }
    : { content }
}

function memo<T>(make: () => T | Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined
  return () => (value ??= Promise.resolve().then(make))
}

/**
 * A stateless (2026-07-28) MCP server factory over oRPC procedures: one fresh
 * server per HTTP request, tools listed in a stable order, and every call run
 * through the procedure's full middleware stack with the request's context.
 */
export function createOrpcMcpFactory<TContext extends object>(options: OrpcMcpOptions<TContext>): McpServerFactory {
  const tools = [...options.tools].sort((a, b) => a.name.localeCompare(b.name))
  const names = new Set(tools.map((t) => t.name))
  if (names.size !== tools.length) throw new Error('MCP tool names must be unique')

  return (request) => {
    const server = new McpServer(options.info, options.instructions ? { instructions: options.instructions } : {})
    const context = memo(() => options.context(request))
    for (const tool of tools) {
      server.registerTool(
        tool.name,
        {
          ...(tool.title ? { title: tool.title } : {}),
          description: tool.description,
          inputSchema: fromJsonSchema(tool.inputSchema),
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
          ...(tool.requiredScopes ? { scopeChallenge: requireScopes(...tool.requiredScopes) } : {}),
        },
        async (input, ctx) => {
          try {
            const output: unknown = await call(tool.procedure, input, {
              context: await context(),
              path: [...tool.path],
              signal: ctx.mcpReq.signal,
            })
            return successResult(output, options.resultNote)
          } catch (error) {
            return options.onError(error, tool)
          }
        },
      )
    }
    return server
  }
}
