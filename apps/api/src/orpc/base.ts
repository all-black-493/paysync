import { INTEGRATOR_SCOPES, can, grants, scopeOf, type Permission } from '@paysync/auth'
import { API_KEY_CONFIG, type Auth } from '../auth.js'
import { contract } from '@paysync/contract'
import { schema, type Db } from '@paysync/db'
import type { Logger } from '@paysync/platform'
import { ORPCError, implement } from '@orpc/server'
import type {
  RequestHeadersHandlerPluginContext,
  ResponseHeadersHandlerPluginContext,
} from '@orpc/server/plugins'
import { and, eq } from 'drizzle-orm'
import { permissionFor } from './permissions.js'

export type Surface = 'web' | 'rest'

export interface InitialContext extends RequestHeadersHandlerPluginContext, ResponseHeadersHandlerPluginContext {
  readonly auth: Auth
  readonly db: Db
  readonly logger: Logger
  readonly surface: Surface
}

export interface Caller {
  readonly kind: 'user' | 'api_key'
  /** User id, or `apikey:<id>` for integrator keys. Used for audit and created_by. */
  readonly actorId: string
  readonly name: string
  readonly email: string | null
  readonly orgId: string
  /** Organization role, or `api_key:<scope>`. */
  readonly role: string
}

export const os = implement(contract).$context<InitialContext>()

function deny(message: string): never {
  throw new ORPCError('FORBIDDEN', { message })
}

async function apiKeyCaller(context: InitialContext, key: string, permission: Permission | null): Promise<Caller> {
  // Integrators use REST; the typed RPC surface is for the web app's session.
  if (context.surface !== 'rest') throw new ORPCError('UNAUTHORIZED')
  const result = await context.auth.api.verifyApiKey({ body: { key, configId: API_KEY_CONFIG } })
  if (!result.valid || !result.key) throw new ORPCError('UNAUTHORIZED', { message: 'Invalid or revoked API key.' })
  const scope = scopeOf(result.key.permissions)
  if (!scope) deny('This API key has no usable scope.')
  if (permission !== null && !grants(INTEGRATOR_SCOPES[scope], permission)) {
    deny('This API key’s scope does not allow this action.')
  }
  return {
    kind: 'api_key',
    actorId: `apikey:${result.key.id}`,
    name: result.key.name ?? 'API key',
    email: null,
    orgId: result.key.referenceId,
    role: `api_key:${scope}`,
  }
}

async function sessionCaller(context: InitialContext, permission: Permission | null): Promise<Caller> {
  const { headers, response: session } = await context.auth.api.getSession({
    headers: context.reqHeaders ?? new Headers(),
    returnHeaders: true,
  })
  for (const cookie of headers.getSetCookie()) context.resHeaders?.append('set-cookie', cookie)
  if (!session) throw new ORPCError('UNAUTHORIZED')

  // The organization always comes from the session, never from a request parameter.
  const orgId = session.session.activeOrganizationId
  if (!orgId) deny('No active organization. Select one first.')

  const [member] = await context.db
    .select({ role: schema.member.role })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, session.user.id)))
  if (!member) deny('You are not a member of the active organization.')
  if (permission !== null && !can(member.role, permission)) deny('Your role does not allow this action.')

  return {
    kind: 'user',
    actorId: session.user.id,
    name: session.user.name,
    email: session.user.email,
    orgId,
    role: member.role,
  }
}

const requireCaller = os.middleware(async ({ context, path, next }) => {
  const permission = permissionFor(path)
  const key = context.reqHeaders?.get('x-api-key')
  const caller = key ? await apiKeyCaller(context, key, permission) : await sessionCaller(context, permission)
  return next({ context: { caller } })
})

export const authed = os.use(requireCaller)
