import { describe, expect, it } from 'vitest'
import { buildScenario } from './simulator.js'

describe('replay scenario', () => {
  it('delivers every callback fixture the requested number of times, rewritten to the shortcode', () => {
    const deliveries = buildScenario({ c2bShortcode: '600984', copies: 3, seed: 7 })
    const counts = new Map<string, number>()
    for (const d of deliveries) counts.set(d.fixture, (counts.get(d.fixture) ?? 0) + 1)
    expect([...counts.values()].every((n) => n === 3)).toBe(true)
    expect(counts.has('stk-callback-success')).toBe(true)
    expect(counts.has('stk-query-pending')).toBe(false)
    const c2b = deliveries.find((d) => d.fixture === 'c2b-confirmation')?.body as { BusinessShortCode: string }
    expect(c2b.BusinessShortCode).toBe('600984')
    const unknown = deliveries.find((d) => d.fixture === 'c2b-confirmation-unknown-shortcode')?.body as { BusinessShortCode: string }
    expect(unknown.BusinessShortCode).toBe('999999')
  })

  it('is shuffled deterministically by seed', () => {
    const a = buildScenario({ c2bShortcode: '600984', copies: 2, seed: 1 }).map((d) => d.fixture)
    const b = buildScenario({ c2bShortcode: '600984', copies: 2, seed: 1 }).map((d) => d.fixture)
    const c = buildScenario({ c2bShortcode: '600984', copies: 2, seed: 2 }).map((d) => d.fixture)
    expect(a).toEqual(b)
    expect(a).not.toEqual(c)
  })
})
