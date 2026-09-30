export type JsonSchema = Record<string, unknown>

export interface StrictOptions {
  /** Applied to string fields that set no `maxLength` of their own. */
  readonly defaultMaxLength: number
}

const isObject = (value: unknown): value is JsonSchema => typeof value === 'object' && value !== null && !Array.isArray(value)

const SUBSCHEMA_LISTS = ['anyOf', 'oneOf', 'allOf', 'prefixItems'] as const
const SUBSCHEMA_MAPS = ['properties', '$defs', 'definitions', 'patternProperties'] as const
const SUBSCHEMAS = ['items', 'not', 'if', 'then', 'else', 'contains', 'additionalProperties'] as const

const typeIncludes = (schema: JsonSchema, type: string): boolean =>
  schema.type === type || (Array.isArray(schema.type) && schema.type.includes(type))

/**
 * A tool input schema with no room for surprises (MCP security best practice):
 * every object closes its properties unless it states otherwise, and every
 * string has a length limit. Returns a new schema; the input is untouched.
 */
export function strictJsonSchema(schema: JsonSchema, options: StrictOptions): JsonSchema {
  const out: JsonSchema = { ...schema }
  for (const key of SUBSCHEMA_LISTS) {
    const list = out[key]
    if (Array.isArray(list)) out[key] = list.map((s: unknown) => (isObject(s) ? strictJsonSchema(s, options) : s))
  }
  for (const key of SUBSCHEMA_MAPS) {
    const map = out[key]
    if (isObject(map)) out[key] = Object.fromEntries(Object.entries(map).map(([k, s]) => [k, isObject(s) ? strictJsonSchema(s, options) : s]))
  }
  for (const key of SUBSCHEMAS) {
    const sub = out[key]
    if (isObject(sub)) out[key] = strictJsonSchema(sub, options)
  }
  if ((typeIncludes(out, 'object') || isObject(out.properties)) && out.additionalProperties === undefined) out.additionalProperties = false
  if (typeIncludes(out, 'string') && out.maxLength === undefined && out.enum === undefined && out.const === undefined) {
    out.maxLength = options.defaultMaxLength
  }
  return out
}
