import { describe, expect, it } from 'vitest'
import { strictJsonSchema } from './schema.js'

const strict = (schema: Record<string, unknown>) => strictJsonSchema(schema, { defaultMaxLength: 100 })

describe('strictJsonSchema', () => {
  it('closes every object, however deeply nested', () => {
    const out = strict({
      type: 'object',
      properties: { amount: { type: 'object', properties: { minor: { type: 'string', pattern: '^\\d+$' } } }, tags: { type: 'array', items: { type: 'object', properties: {} } } },
      anyOf: [{ type: 'object', properties: { a: { type: 'number' } } }],
    })
    expect(out).toMatchObject({
      additionalProperties: false,
      properties: { amount: { additionalProperties: false, properties: { minor: { maxLength: 100, pattern: '^\\d+$' } } }, tags: { items: { additionalProperties: false } } },
      anyOf: [{ additionalProperties: false }],
    })
  })

  it('keeps limits and choices the schema already states', () => {
    const out = strict({ type: 'object', properties: { a: { type: 'string', maxLength: 10 }, b: { type: 'string', enum: ['x', 'y'] } }, additionalProperties: { type: 'string' } })
    expect(out.properties).toEqual({ a: { type: 'string', maxLength: 10 }, b: { type: 'string', enum: ['x', 'y'] } })
    expect(out.additionalProperties).toEqual({ type: 'string', maxLength: 100 })
  })

  it('leaves the input untouched', () => {
    const input = { type: 'object', properties: { a: { type: 'string' } } }
    strict(input)
    expect(input).toEqual({ type: 'object', properties: { a: { type: 'string' } } })
  })
})
