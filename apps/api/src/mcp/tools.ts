import { strictJsonSchema, type JsonSchema, type ProcedureTool } from '@paysync/orpc-mcp'
import { agentProcedures, approvalPolicyOf, type AgentMeta } from '@paysync/contract'
import type { AnyProcedure } from '@orpc/server'
import { descriptionOf } from '../agent/describe.js'
import { router } from '../orpc/router.js'
import { READ_SCOPE, WRITE_SCOPE } from './oauth.js'

const MAX_STRING = 2000

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

type JsonSchemaOf = (options: { readonly target: string }) => unknown
const isJsonSchemaOf = (value: unknown): value is JsonSchemaOf => typeof value === 'function'

/** The Standard JSON Schema of a validator (Zod implements it), for the tool's advertised arguments. */
function standardJsonSchema(schema: unknown): JsonSchema | undefined {
  if (!isRecord(schema) || !isRecord(schema['~standard'])) return undefined
  const jsonSchema = schema['~standard'].jsonSchema
  if (!isRecord(jsonSchema) || !isJsonSchemaOf(jsonSchema.input)) return undefined
  const out: unknown = jsonSchema.input({ target: 'draft-2020-12' })
  return isRecord(out) ? out : undefined
}

function inputJsonSchema(procedure: AnyProcedure, path: string): JsonSchema {
  const schemas: readonly unknown[] = procedure['~orpc'].inputSchemas ?? []
  const json = schemas.length === 0 ? { type: 'object', properties: {} } : schemas.length === 1 ? standardJsonSchema(schemas[0]) : undefined
  if (!json) throw new Error(`MCP tool ${path} needs exactly one input schema with a JSON Schema`)
  return strictJsonSchema(json, { defaultMaxLength: MAX_STRING })
}

function annotationsOf(agent: AgentMeta): ProcedureTool['annotations'] {
  return {
    readOnlyHint: agent.risk === 'read',
    destructiveHint: agent.risk === 'destructive' || agent.money === true,
    idempotentHint: true,
    openWorldHint: false,
  }
}

/** Reads that never wait for approval need `paysync:read`; everything else also needs `paysync:write`. */
const scopesOf = (agent: AgentMeta): readonly [string, ...string[]] =>
  agent.risk === 'read' && approvalPolicyOf(agent) === 'never' ? [READ_SCOPE] : [READ_SCOPE, WRITE_SCOPE]

/** The MCP surface (§9.3): one tool per procedure whose agent meta exposes it to MCP, described from the contract. */
export function mcpTools(): ProcedureTool[] {
  return agentProcedures<AnyProcedure>(router, 'mcp').map((p) => ({
    name: p.agent.name,
    description: descriptionOf(p.meta),
    inputSchema: inputJsonSchema(p.procedure, p.path),
    annotations: annotationsOf(p.agent),
    requiredScopes: scopesOf(p.agent),
    procedure: p.procedure,
    path: p.path.split('.'),
  }))
}
