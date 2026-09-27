import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

export const FIXTURES_DIR = fileURLToPath(new URL('../fixtures', import.meta.url))

const FixtureFile = z.object({
  meta: z.object({
    kind: z.enum([
      'c2b_confirmation',
      'c2b_validation',
      'stk_callback',
      'stk_push_response',
      'stk_query_response',
      'daraja_error',
      'oauth_response',
      'async_request_response',
      'transaction_status_result',
      'account_balance_result',
      'pull_response',
    ]),
    provenance: z.string(),
    note: z.string().optional(),
    httpStatus: z.number().int().optional(),
  }),
  payload: z.unknown(),
})

export interface Fixture extends z.infer<typeof FixtureFile> {
  readonly name: string
}

export function loadFixtures(dir: string = FIXTURES_DIR): Map<string, Fixture> {
  const out = new Map<string, Fixture>()
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const name = file.slice(0, -'.json'.length)
    out.set(name, { name, ...FixtureFile.parse(JSON.parse(readFileSync(join(dir, file), 'utf8'))) })
  }
  return out
}

export function fixture(name: string, dir?: string): Fixture {
  const found = loadFixtures(dir).get(name)
  if (!found) throw new Error(`no fixture named ${name}`)
  return found
}
