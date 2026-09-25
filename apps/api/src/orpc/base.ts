import { can, type Auth } from '@paysync/auth'
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
  readonly userId: string
  readonly name: string
  readonly email: string
  readonly orgId: string
  readonly role: string
}

export const os = implement(contract).$context<InitialContext>()

const requireCaller = os.middleware(async ({ context, path, next }) => {
  const permission = permissionFor(path)
  const { headers, response: session } = await context.auth.api.getSession({
    headers: context.reqHeaders ?? new Headers(),
    returnHeaders: true,
  })
  for (const cookie of headers.getSetCookie()) context.resHeaders?.append('set-cookie', cookie)
  if (!session) throw new ORPCError('UNAUTHORIZED')

  // The organization always comes from the session, never from a request parameter.
  const orgId = session.session.activeOrganizationId
  if (!orgId) throw new ORPCError('FORBIDDEN', { message: 'No active organization. Select one first.' })

  const [member] = await context.db
    .select({ role: schema.member.role })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, session.user.id)))
  if (!member) throw new ORPCError('FORBIDDEN', { message: 'You are not a member of the active organization.' })
  if (permission !== null && !can(member.role, permission)) {
    throw new ORPCError('FORBIDDEN', { message: 'Your role does not allow this action.' })
  }

  const caller: Caller = {
    userId: session.user.id,
    name: session.user.name,
    email: session.user.email,
    orgId,
    role: member.role,
  }
  return next({ context: { caller } })
})

export const authed = os.use(requireCaller)
