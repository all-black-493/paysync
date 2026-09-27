import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { PERMISSIONS, permissionFor } from './orpc/permissions.js'
import { generateSpec } from './server.js'

describe('public contract', () => {
  it('matches the reviewed OpenAPI document (run `make snapshots` after an intended change)', async () => {
    const spec = await generateSpec()
    await expect(`${JSON.stringify(spec, null, 2)}\n`).toMatchFileSnapshot('./__snapshots__/openapi.json')
  })

  it('every operation has a summary and a description written for agents', async () => {
    const Operation = z.object({ summary: z.string().min(1), description: z.string().min(40) })
    const paths = z.record(z.string(), z.record(z.string(), z.unknown())).parse((await generateSpec()).paths)
    for (const [path, item] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(item)) {
        expect(Operation.safeParse(operation).success, `${method} ${path}`).toBe(true)
      }
    }
  })

  it('fails closed for procedures without a permission mapping', () => {
    expect(() => permissionFor(['expected', 'void'])).toThrow(/no permission mapping/)
    expect(() => permissionFor(['expected'])).toThrow(/no permission mapping/)
    expect(permissionFor(['expected', 'create'])).toBe(PERMISSIONS.expected.create)
    expect(permissionFor(['me', 'get'])).toBeNull()
  })
})
