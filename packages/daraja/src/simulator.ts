import { loadFixtures } from './fixtures.js'

export type CallbackKind = 'c2b/confirmation' | 'c2b/validation' | 'stk'

export interface Delivery {
  readonly kind: CallbackKind
  readonly fixture: string
  readonly body: unknown
}

const KIND_FOR: Partial<Record<string, CallbackKind>> = {
  c2b_confirmation: 'c2b/confirmation',
  c2b_validation: 'c2b/validation',
  stk_callback: 'stk',
}

/** Deterministic shuffle so a failing replay can be reproduced from its seed. */
function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items]
  let state = seed >>> 0 || 1
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1_103_515_245 + 12_345) >>> 0
    const j = state % (i + 1)
    const a = out[i]
    const b = out[j]
    if (a !== undefined && b !== undefined) {
      out[i] = b
      out[j] = a
    }
  }
  return out
}

export interface ScenarioOptions {
  /** Shortcode that C2B fixtures are rewritten to (fixtures meant for "unknown" keep theirs). */
  readonly c2bShortcode: string
  /** How many times each callback is delivered. */
  readonly copies: number
  readonly seed: number
}

/** Every callback fixture, delivered `copies` times in a shuffled order. */
export function buildScenario(options: ScenarioOptions): Delivery[] {
  const deliveries: Delivery[] = []
  for (const fixture of loadFixtures().values()) {
    const kind = KIND_FOR[fixture.meta.kind]
    if (!kind) continue
    let body = fixture.payload
    if (kind !== 'stk' && body && typeof body === 'object' && !fixture.name.includes('unknown-shortcode')) {
      body = { ...body, BusinessShortCode: options.c2bShortcode }
    }
    for (let i = 0; i < options.copies; i++) deliveries.push({ kind, fixture: fixture.name, body })
  }
  return shuffle(deliveries, options.seed)
}

export interface ReplayResult {
  readonly sent: number
  readonly acknowledged: number
  readonly failures: ReadonlyArray<{ fixture: string; status: number }>
}

/** Posts deliveries to the callback routes, a few at a time to exercise concurrency. */
export async function replay(
  baseUrl: string,
  secret: string,
  deliveries: readonly Delivery[],
  concurrency = 4,
): Promise<ReplayResult> {
  const failures: Array<{ fixture: string; status: number }> = []
  let acknowledged = 0
  const queue = [...deliveries]
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const res = await fetch(`${baseUrl}/hooks/${next.kind}/${secret}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(next.body),
      })
      await res.arrayBuffer()
      if (res.status === 200) acknowledged++
      else failures.push({ fixture: next.fixture, status: res.status })
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  return { sent: deliveries.length, acknowledged, failures }
}
