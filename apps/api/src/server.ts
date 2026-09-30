import { JEV_NOT_CONFIGURED, type Jev } from '@paysync/decisions'
import type { Assistant } from './agent/assistant.js'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Auth } from './auth.js'
import { checkMigrations, type Db, type Migration, type Pool } from '@paysync/db'
import { createHealthRoutes, type HealthRoutes, type Logger } from '@paysync/platform'
import { ERROR_STATUS } from '@paysync/contract'
import { COMMON_ERROR_STATUS_MAP, OpenAPIGenerator } from '@orpc/openapi'
import { OpenAPIHandler } from '@orpc/openapi/node'
import { OpenAPIReferenceHandlerPlugin } from '@orpc/openapi/plugins'
import { ORPCError, onError } from '@orpc/server'
import { RPCHandler } from '@orpc/server/node'
import {
  CORSHandlerPlugin,
  GetMethodCsrfProtectionHandlerPlugin,
  PrototypePollutionProtectionHandlerPlugin,
  RequestHeadersHandlerPlugin,
  RequestLimitHandlerPlugin,
  ResponseHeadersHandlerPlugin,
} from '@orpc/server/plugins'
import { ZodToJsonSchemaConverter } from '@orpc/zod'
import { toNodeHandler } from 'better-auth/node'
import { createHookHandler, type HookOptions } from './hooks.js'
import { router } from './orpc/router.js'

export interface ApiServerDeps {
  readonly pool: Pool
  readonly db: Db
  readonly auth: Auth
  /** Jev for the guard's judgement of agent actions; fails closed when absent. */
  readonly jev?: Jev
  /** The in-app assistant; the chat answers ASSISTANT_OFF when absent. */
  readonly assistant?: Assistant
  readonly migrations: readonly Migration[]
  readonly logger: Logger
  /** Browser-facing origin; the only CORS origin allowed. */
  readonly publicUrl: string
  /** Serve the API reference UI and spec (non-production only). */
  readonly docs: boolean
  readonly hooks: Omit<HookOptions, 'db' | 'logger'>
}

export interface ApiServer {
  readonly server: Server
  readonly health: HealthRoutes
}

const MAX_BODY_BYTES = 1024 * 1024
const errorStatusMap = { ...COMMON_ERROR_STATUS_MAP, ...ERROR_STATUS }

export function openApiGenerator() {
  return new OpenAPIGenerator({ converters: [new ZodToJsonSchemaConverter()] })
}

export function generateSpec(): ReturnType<OpenAPIGenerator['generate']> {
  return openApiGenerator().generate(router, {
    base: {
      info: { title: 'Paysync API', version: '1.0.0' },
      servers: [{ url: '/api' }],
      components: {
        securitySchemes: {
          apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key', description: 'Integrator API key (REST only).' },
          session: { type: 'apiKey', in: 'cookie', name: 'paysync.session_token', description: 'Web session.' },
        },
      },
      security: [{ apiKey: [] }, { session: [] }],
    },
    errorStatusMap,
  })
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

  const logError = (error: unknown) => {
    if (error instanceof ORPCError && error.code !== 'INTERNAL_SERVER_ERROR') return
    deps.logger.error({ err: error }, 'procedure failed')
  }
  const commonPlugins = () => [
    new CORSHandlerPlugin({ origin: [deps.publicUrl], credentials: true }),
    new RequestLimitHandlerPlugin({ maxBodySize: MAX_BODY_BYTES }),
    new PrototypePollutionProtectionHandlerPlugin(),
    new RequestHeadersHandlerPlugin(),
    new ResponseHeadersHandlerPlugin(),
  ]

  const rpc = new RPCHandler(router, { plugins: commonPlugins(), interceptors: [onError(logError)] })
  const rest = new OpenAPIHandler(router, {
    errorStatusMap,
    plugins: [
      ...commonPlugins(),
      new GetMethodCsrfProtectionHandlerPlugin(),
      ...(deps.docs
        ? [
            new OpenAPIReferenceHandlerPlugin({
              docsPath: '/v1/docs',
              specPath: '/v1/openapi.json',
              spec: generateSpec,
            }),
          ]
        : []),
    ],
    interceptors: [onError(logError)],
  })
  const authHandler = toNodeHandler(deps.auth)
  const hooks = createHookHandler({ ...deps.hooks, db: deps.db, logger: deps.logger })

  const baseContext = { auth: deps.auth, db: deps.db, logger: deps.logger, jev: deps.jev ?? JEV_NOT_CONFIGURED, ...(deps.assistant ? { assistant: deps.assistant } : {}) }

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (health.handle(req, res)) return
    if (await hooks(req, res)) return
    const path = (req.url ?? '').split('?', 1)[0] ?? ''

    // Keys are issued only through apiKeys.create, which fixes their permissions.
    if (path.startsWith('/api/auth/api-key/')) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ status: 'not_found' }))
      return
    }
    if (path.startsWith('/api/auth/')) {
      await authHandler(req, res)
      return
    }
    if (path.startsWith('/api/rpc/')) {
      const { matched } = await rpc.handle(req, res, { prefix: '/api/rpc', context: { ...baseContext, surface: 'web' } })
      if (matched) return
    } else if (path.startsWith('/api/v1/')) {
      const { matched } = await rest.handle(req, res, { prefix: '/api', context: { ...baseContext, surface: 'rest' } })
      if (matched) return
    }
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ status: 'not_found' }))
  }

  const server = createServer((req, res) => {
    route(req, res).catch((error: unknown) => {
      deps.logger.error({ err: error }, 'unhandled request error')
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ status: 'internal_error' }))
    })
  })
  server.on('clientError', (error, socket) => {
    deps.logger.debug({ err: error }, 'client error')
    socket.destroy()
  })

  return { server, health }
}
