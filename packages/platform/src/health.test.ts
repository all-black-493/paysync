import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createHealthRoutes, createHealthServer, type ReadinessCheck } from './health.js'
import { closeServer, listen } from './shutdown.js'

const servers: Array<ReturnType<typeof createHealthServer>> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer))
})

async function start(checks: readonly ReadinessCheck[], checkTimeoutMs?: number) {
  const routes = createHealthRoutes({ checks, ...(checkTimeoutMs === undefined ? {} : { checkTimeoutMs }) })
  const server = createHealthServer(routes)
  servers.push(server)
  await listen(server, 0, '127.0.0.1')
  const { port } = server.address() as AddressInfo
  return { routes, url: (path: string) => `http://127.0.0.1:${port}${path}` }
}

const ok: ReadinessCheck = { name: 'ok', run: () => Promise.resolve({ ok: true }) }

describe('health routes', () => {
  it('/healthz is 200 even when readiness fails', async () => {
    const { url } = await start([{ name: 'db', run: () => Promise.resolve({ ok: false }) }])
    expect((await fetch(url('/healthz'))).status).toBe(200)
    expect((await fetch(url('/readyz'))).status).toBe(503)
  })

  it('/readyz is 200 only when every check passes', async () => {
    const { url } = await start([ok, ok])
    const res = await fetch(url('/readyz'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'ready' })
  })

  it('treats a throwing or slow check as not ready', async () => {
    const { url } = await start(
      [
        { name: 'throws', run: () => Promise.reject(new Error('boom')) },
        { name: 'slow', run: () => new Promise(() => undefined) },
      ],
      50,
    )
    const res = await fetch(url('/readyz'))
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({
      checks: [
        { name: 'throws', ok: false, detail: 'boom' },
        { name: 'slow', ok: false, detail: 'timed out after 50ms' },
      ],
    })
  })

  it('reports draining as not ready', async () => {
    const { routes, url } = await start([ok])
    routes.startDraining()
    expect((await fetch(url('/readyz'))).status).toBe(503)
  })

  it('404s other paths and 405s non-GET methods', async () => {
    const { url } = await start([ok])
    expect((await fetch(url('/other'))).status).toBe(404)
    expect((await fetch(url('/healthz'), { method: 'POST' })).status).toBe(405)
  })
})
