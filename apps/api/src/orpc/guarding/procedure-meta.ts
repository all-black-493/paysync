import { agentMetaOf, contract, type AgentMeta } from '@paysync/contract'
import { z } from 'zod'
import { ActionError } from './types.js'

interface ContractProcedure {
  readonly '~orpc': { readonly meta: Readonly<Record<PropertyKey, unknown>>; readonly inputSchemas?: readonly unknown[] }
}

function procedureOf(path: string): ContractProcedure {
  let node: unknown = contract
  for (const segment of path.split('.')) {
    if (typeof node !== 'object' || node === null || !Object.hasOwn(node, segment)) throw new Error(`unknown procedure ${path}`)
    node = (node as Record<string, unknown>)[segment]
  }
  return node as ContractProcedure
}

export function agentMetaFor(path: string): AgentMeta | undefined {
  return agentMetaOf(procedureOf(path)['~orpc'].meta)
}

const StandardResult = z.union([z.object({ value: z.unknown() }), z.object({ issues: z.array(z.unknown()) })])

interface StandardSchema {
  readonly '~standard': { validate(value: unknown): unknown }
}

function isStandardSchema(value: unknown): value is StandardSchema {
  if (typeof value !== 'object' || value === null || !('~standard' in value)) return false
  const standard = value['~standard']
  return typeof standard === 'object' && standard !== null && 'validate' in standard && typeof standard.validate === 'function'
}

/** Re-validates a stored request with the procedure's own input schemas before it runs. */
export async function validateStoredInput(path: string, input: unknown): Promise<unknown> {
  let value = input
  for (const candidate of procedureOf(path)['~orpc'].inputSchemas ?? []) {
    if (!isStandardSchema(candidate)) continue
    const outcome = StandardResult.parse(await candidate['~standard'].validate(value))
    if ('issues' in outcome) throw new ActionError('INVALID_STATE', 'the stored request no longer validates', { status: 'invalid_request' })
    value = outcome.value
  }
  return value
}
