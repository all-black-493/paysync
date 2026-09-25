import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

export interface ReadinessResult {
  readonly ok: boolean
  readonly detail?: string
}

export interface ReadinessCheck {
  readonly name: string
  readonly run: (signal: AbortSignal) => Promise<ReadinessResult>
}

export interface HealthRoutesOptions {
  readonly checks: readonly ReadinessCheck[]
  readonly checkTimeoutMs?: number
}

export interface HealthRoutes {
  readonly handle: (req: IncomingMessage, res: ServerResponse) => boolean
  readonly startDraining: () => void
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function runCheck(check: ReadinessCheck, timeoutMs: number): Promise<ReadinessResult> {
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    return await Promise.race([
      check.run(signal),
      new Promise<ReadinessResult>((resolve) => {
        signal.addEventListener('abort', () => {
          resolve({ ok: false, detail: `timed out after ${timeoutMs}ms` })
        })
      }),
    ])
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : 'check failed' }
  }
}

export function createHealthRoutes(options: HealthRoutesOptions): HealthRoutes {
  const timeoutMs = options.checkTimeoutMs ?? 2_000
  let draining = false

  const readiness = async (res: ServerResponse): Promise<void> => {
    if (draining) {
      sendJson(res, 503, { status: 'draining' })
      return
    }
    const results = await Promise.all(
      options.checks.map(async (check) => ({ name: check.name, ...(await runCheck(check, timeoutMs)) })),
    )
    const ok = results.every((r) => r.ok)
    sendJson(res, ok ? 200 : 503, { status: ok ? 'ready' : 'not_ready', checks: results })
  }

  return {
    handle(req, res) {
      const path = (req.url ?? '').split('?', 1)[0]
      if (path !== '/healthz' && path !== '/readyz') return false
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { status: 'method_not_allowed' })
        return true
      }
      if (path === '/healthz') {
        sendJson(res, 200, { status: 'ok' })
        return true
      }
      readiness(res).catch((error: unknown) => {
        sendJson(res, 503, { status: 'not_ready', detail: error instanceof Error ? error.message : 'unknown' })
      })
      return true
    },
    startDraining() {
      draining = true
    },
  }
}

export function createHealthServer(routes: HealthRoutes): Server {
  return createServer((req, res) => {
    if (!routes.handle(req, res)) sendJson(res, 404, { status: 'not_found' })
  })
}
