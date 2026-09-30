import { INTEGRATOR_RULES, customRolePermissions, isRoleName, parseRoleList, rulesForMember, scopeOf, type AppPermission } from '@paysync/auth'
import { API_KEY_CONFIG, type Auth } from '../auth.js'
import { agentMetaOf, approvalPolicyOf, contract } from '@paysync/contract'
import { schema, type Db } from '@paysync/db'
import type { Logger } from '@paysync/platform'
import { ORPCError, implement } from '@orpc/server'
import type {
  RequestHeadersHandlerPluginContext,
  ResponseHeadersHandlerPluginContext,
} from '@orpc/server/plugins'
import type { Jev } from '@paysync/decisions'
import { and, eq, inArray } from 'drizzle-orm'
import type { Assistant } from '../agent/assistant.js'
import { READ_SCOPE, WRITE_SCOPE, clientIdOf, scopesOf, type McpClaims } from '../mcp/oauth.js'
import type { AgentSession } from './guarding/types.js'
import { permissionFor } from './permissions.js'
import { permix } from './permix.js'

/** Where a call comes from. */
export type Surface = 'web' | 'rest' | 'ai-sdk' | 'mcp'

export interface InitialContext extends RequestHeadersHandlerPluginContext, ResponseHeadersHandlerPluginContext {
  readonly auth: Auth
  readonly db: Db
  readonly logger: Logger
  readonly surface: Surface
  /** Only packages/decisions talks to Jev; this is the client it uses. */
  readonly jev: Jev
  /** Present on agent surfaces: the session and the person's request (M7/M8). */
  readonly agent?: AgentSession
  /** The in-app assistant, when switched on. */
  readonly assistant?: Assistant
  /** On the MCP surface: the verified access token's claims (signature, issuer, audience, expiry already checked). */
  readonly mcp?: McpClaims
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
  /** For signed-in users: what approvals check (§6C.4). */
  readonly session: { readonly id: string; readonly createdAt: Date; readonly twoFactorEnabled: boolean } | null
  /** The agent session acting for this person (AI SDK, MCP); null for direct calls. Stored on every audit event. */
  readonly agentSessionId: string | null
  /** The OAuth client acting for this person on MCP; null elsewhere. */
  readonly mcpClientId: string | null
}

export const os = implement(contract).$context<InitialContext>()

function deny(message: string): never {
  throw new ORPCError('FORBIDDEN', { message })
}

type Rules = Parameters<typeof permix.setupContext>[0]

interface Resolved {
  readonly caller: Caller
  readonly rules: Rules
}

async function apiKeyCaller(context: InitialContext, key: string): Promise<Resolved> {
  // Integrators use REST; the typed RPC surface is for the web app's session.
  if (context.surface !== 'rest') throw new ORPCError('UNAUTHORIZED')
  const result = await context.auth.api.verifyApiKey({ body: { key, configId: API_KEY_CONFIG } })
  if (!result.valid || !result.key) throw new ORPCError('UNAUTHORIZED', { message: 'Invalid or revoked API key.' })
  const scope = scopeOf(result.key.permissions)
  if (!scope) deny('This API key has no usable scope.')
  return {
    caller: {
      kind: 'api_key',
      actorId: `apikey:${result.key.id}`,
      name: result.key.name ?? 'API key',
      email: null,
      orgId: result.key.referenceId,
      role: `api_key:${scope}`,
      session: null,
      agentSessionId: null,
      mcpClientId: null,
    },
    rules: INTEGRATOR_RULES[scope],
  }
}

async function sessionCaller(context: InitialContext): Promise<Resolved> {
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

  return {
    caller: {
      kind: 'user',
      actorId: session.user.id,
      name: session.user.name,
      email: session.user.email,
      orgId,
      role: member.role,
      session: {
        id: session.session.id,
        createdAt: new Date(session.session.createdAt),
        twoFactorEnabled: session.user.twoFactorEnabled === true,
      },
      agentSessionId: context.agent?.sessionId ?? null,
      mcpClientId: null,
    },
    rules: rulesForMember(member.role, await customRoles(context.db, orgId, member.role)),
  }
}

/** An external agent with an OAuth token: it acts as the person who consented, in the organization they consented for. */
async function mcpCaller(context: InitialContext, claims: McpClaims): Promise<Resolved> {
  const [row] = await context.db
    .select({ role: schema.member.role, name: schema.user.name, email: schema.user.email })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
    .where(and(eq(schema.member.organizationId, claims.org), eq(schema.member.userId, claims.sub)))
  if (!row) deny('You are no longer a member of the organization this app was connected to.')
  const [consent] = await context.db
    .select({ id: schema.oauthConsent.id })
    .from(schema.oauthConsent)
    .where(and(eq(schema.oauthConsent.userId, claims.sub), eq(schema.oauthConsent.clientId, clientIdOf(claims)), eq(schema.oauthConsent.referenceId, claims.org)))
  if (!consent) throw new ORPCError('UNAUTHORIZED', { message: 'This app was disconnected. Connect it again from the app.' })
  return {
    caller: {
      kind: 'user',
      actorId: claims.sub,
      name: row.name,
      email: row.email,
      orgId: claims.org,
      role: row.role,
      session: null,
      agentSessionId: context.agent?.sessionId ?? null,
      mcpClientId: clientIdOf(claims),
    },
    rules: rulesForMember(row.role, await customRoles(context.db, claims.org, row.role)),
  }
}

/** §8.3 step 1 on MCP: only agent tools, and only with the scope their risk needs. */
function checkMcpExposure(meta: Readonly<Record<PropertyKey, unknown>>, claims: McpClaims): void {
  const agent = agentMetaOf(meta)
  if (!agent || !(agent.exposeTo ?? ['ai-sdk', 'mcp']).includes('mcp')) deny('Not available to connected apps.')
  const needed = agent.risk === 'read' && approvalPolicyOf(agent) === 'never' ? READ_SCOPE : WRITE_SCOPE
  if (!scopesOf(claims).includes(needed)) deny(`This app was not granted ${needed}.`)
}

function parsedPermission(stored: string): unknown {
  try {
    return JSON.parse(stored) as unknown
  } catch {
    return null
  }
}

/** The organization's own roles this member holds; a malformed or missing one grants nothing. */
async function customRoles(db: InitialContext['db'], orgId: string, memberRole: string): Promise<Map<string, AppPermission[]>> {
  const names = parseRoleList(memberRole).filter((r) => !isRoleName(r))
  if (names.length === 0) return new Map()
  const rows = await db
    .select({ role: schema.organizationRole.role, permission: schema.organizationRole.permission })
    .from(schema.organizationRole)
    .where(and(eq(schema.organizationRole.organizationId, orgId), inArray(schema.organizationRole.role, names)))
  return new Map(rows.map((r) => [r.role, customRolePermissions(parsedPermission(r.permission))]))
}

async function resolveCaller(context: InitialContext, meta: Readonly<Record<PropertyKey, unknown>>): Promise<Resolved> {
  if (context.surface === 'mcp') {
    if (!context.mcp) throw new ORPCError('UNAUTHORIZED')
    checkMcpExposure(meta, context.mcp)
    return mcpCaller(context, context.mcp)
  }
  const key = context.reqHeaders?.get('x-api-key')
  return key ? apiKeyCaller(context, key) : sessionCaller(context)
}

const requireCaller = os.middleware(async ({ context, path, procedure, next }) => {
  const required = permissionFor(path)
  const { caller, rules } = await resolveCaller(context, procedure['~orpc'].meta)
  const permissions = permix.setupContext(rules)
  if (required !== null && !permissions.permix.check(required)) {
    deny(caller.kind === 'api_key' ? 'This API key’s scope does not allow this action.' : 'Your role does not allow this action.')
  }
  return next({ context: { caller, ...permissions } })
})

export const authed = os.use(requireCaller)
