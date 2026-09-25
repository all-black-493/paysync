import { createServer, type Server } from 'node:http'
import { checkMigrations, type Migration, type Pool } from '@paysync/db'
import { createHealthRoutes, type HealthRoutes, type Logger } from '@paysync/platform'

export interface ApiServerDeps {
  readonly pool: Pool
  readonly migrations: readonly Migration[]
  readonly logger: Logger
}

export interface ApiServer {
  readonly server: Server
  readonly health: HealthRoutes
}

export function createApiServer(deps: ApiServerDeps): ApiServer {
  const health = createHealthRoutes({
    checks: [
      {
        name: 'database',
        run: async () => {
          await deps.pool.query('SELECT 1')
          return { ok: true }
        },
      },
      {
        name: 'migrations',
        run: async () => {
          const status = await checkMigrations(deps.pool, deps.migrations)
          return status.ok ? { ok: true } : { ok: false, detail: `missing: ${status.missing.join(', ')}` }
        },
      },
    ],
  })

  const server = createServer((req, res) => {
    if (health.handle(req, res)) return
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ status: 'not_found' }))
  })
  server.on('clientError', (error, socket) => {
    deps.logger.debug({ err: error }, 'client error')
    socket.destroy()
  })

  return { server, health }
}
