import { CUSTOM_ROLE_ENTITIES, isValidCustomRoleName } from '@paysync/auth'
import { schema, withOrg, type Db } from '@paysync/db'
import { APIError, getSessionFromCtx } from 'better-auth/api'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { redact } from './orpc/mutate.js'

type HookContext = Parameters<typeof getSessionFromCtx>[0]

const Statements = z.record(z.string(), z.array(z.string()))
const CreateRole = z.object({ role: z.string(), permission: Statements })
const UpdateRole = z.object({ data: z.object({ roleName: z.string().optional(), permission: Statements.optional() }) })
const UpdateMemberRole = z.object({ memberId: z.string() })
const SessionShape = z.object({
  user: z.object({ id: z.string() }),
  session: z.object({ id: z.string(), activeOrganizationId: z.string().nullish() }),
})
const Body = z.record(z.string(), z.unknown())

async function sessionOf(ctx: HookContext): Promise<z.infer<typeof SessionShape> | null> {
  const parsed = SessionShape.safeParse(await getSessionFromCtx(ctx))
  return parsed.success ? parsed.data : null
}

/** Better Auth routes that change who can do what; each is checked before and audited after. */
export const TEAM_PATHS = new Set([
  '/organization/create-role',
  '/organization/update-role',
  '/organization/delete-role',
  '/organization/update-member-role',
  '/organization/invite-member',
  '/organization/cancel-invitation',
  '/organization/remove-member',
])

function onlyWorkPermissions(permission: Record<string, string[]>): void {
  const outside = Object.keys(permission).filter((entity) => !(CUSTOM_ROLE_ENTITIES as readonly string[]).includes(entity))
  if (outside.length > 0) {
    throw new APIError('BAD_REQUEST', { message: `Custom roles cannot manage ${outside.join(', ')}; that stays with owners and admins.` })
  }
}

function validName(name: string): void {
  if (!isValidCustomRoleName(name)) {
    throw new APIError('BAD_REQUEST', { message: 'Use 3 to 40 letters, digits, spaces or hyphens, and not a built-in role name.' })
  }
}

/**
 * Rules Better Auth does not have: custom roles hold reconciliation work only,
 * names are readable, and nobody changes their own role.
 */
export async function guardTeamChange(db: Db, ctx: HookContext & { path: string; body?: unknown }): Promise<void> {
  if (ctx.path === '/organization/create-role') {
    const body = CreateRole.safeParse(ctx.body)
    if (!body.success) return
    validName(body.data.role)
    onlyWorkPermissions(body.data.permission)
  }
  if (ctx.path === '/organization/update-role') {
    const body = UpdateRole.safeParse(ctx.body)
    if (!body.success) return
    // Members hold roles by name, so a rename would silently strip it from them.
    if (body.data.data.roleName !== undefined) throw new APIError('BAD_REQUEST', { message: 'Roles cannot be renamed. Create a new role and move people to it.' })
    if (body.data.data.permission) onlyWorkPermissions(body.data.data.permission)
  }
  if (ctx.path === '/organization/update-member-role') {
    const body = UpdateMemberRole.safeParse(ctx.body)
    const session = await sessionOf(ctx)
    if (!body.success || !session) return
    const [target] = await db.select({ userId: schema.member.userId }).from(schema.member).where(eq(schema.member.id, body.data.memberId))
    if (target?.userId === session.user.id) throw new APIError('FORBIDDEN', { message: 'Someone else must change your role.' })
  }
}

/** One audit event per team or role change, success or refusal (§6C.6). */
export async function auditTeamChange(db: Db, ctx: HookContext & { path: string; body?: unknown; context: { returned?: unknown } }): Promise<void> {
  const session = await sessionOf(ctx)
  const orgId = session?.session.activeOrganizationId
  if (!session || !orgId) return
  const [member] = await db
    .select({ id: schema.member.id })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, session.user.id)))
  if (!member) return
  const refused = ctx.context.returned instanceof APIError
  const body = Body.safeParse(ctx.body)
  await withOrg(db, orgId, (tx) =>
    tx.insert(schema.auditEvent).values({
      orgId,
      surface: 'web',
      userId: session.user.id,
      action: `team.${ctx.path.replace('/organization/', '')}`,
      input: body.success ? redact(body.data) : null,
      decision: null,
      outcome: refused ? 'refused' : 'changed',
      details: { sessionId: session.session.id },
    }),
  )
}
