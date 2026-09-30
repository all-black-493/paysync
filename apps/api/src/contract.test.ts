import { agentMetaOf, contract, listProcedures, type AgentMeta } from '@paysync/contract'
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
    expect(() => permissionFor(['expected', 'nothing'])).toThrow(/no permission mapping/)
    expect(() => permissionFor(['expected'])).toThrow(/no permission mapping/)
    expect(permissionFor(['expected', 'create'])).toBe(PERMISSIONS.expected.create)
    expect(permissionFor(['me', 'get'])).toBeNull()
  })
})

const all = listProcedures(contract)
const tools = all.flatMap((p) => {
  const meta = agentMetaOf(p.meta)
  return meta ? [{ path: p.path, meta }] : []
})

describe('agent tools (router enumeration, §8.1)', () => {
  it('finds every procedure', () => {
    expect(all.length).toBeGreaterThan(20)
  })

  it('only procedures with agent metadata can become tools; approvals and key management never do', () => {
    const toolPaths = new Set(tools.map((t) => t.path))
    for (const path of ['approvals.decide', 'apiKeys.list', 'apiKeys.create', 'apiKeys.revoke']) expect(toolPaths.has(path), path).toBe(false)
    expect(tools.some((t) => /approv/i.test(t.meta.name))).toBe(false)
  })

  it('tool names are unique and stable', () => {
    const names = tools.map((t) => t.meta.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('money actions need two approvers; destructive ones never skip approval', () => {
    for (const { path, meta } of tools) {
      if (meta.money) expect(meta.approvers, path).toBe(2)
      if (meta.risk === 'destructive') expect(meta.approval ?? 'always', path).toBe('always')
    }
  })

  it('matches the reviewed tool list (run `make snapshots` after an intended change)', async () => {
    const description = (path: string) => {
      const route = z.object({ '~openapi': z.object({ description: z.string() }).optional() }).safeParse(all.find((p) => p.path === path)?.meta)
      return route.success ? (route.data['~openapi']?.description ?? '') : ''
    }
    const list = tools.map(({ path, meta }): AgentMeta & { path: string; description: string } => ({ path, ...meta, description: description(path) }))
    await expect(`${JSON.stringify(list, null, 2)}\n`).toMatchFileSnapshot('./__snapshots__/agent-tools.json')
  })
})
