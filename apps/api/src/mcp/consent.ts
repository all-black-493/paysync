import { schema, withOrg, type Db } from '@paysync/db'
import { APIError } from 'better-auth/api'
import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { sessionOf, type HookContext } from '../auth-roles.js'

export const CONSENT_PATH = '/oauth2/consent'
export const DISCONNECT_PATH = '/oauth2/delete-consent'

const ConsentBody = z.object({ accept: z.boolean().optional(), oauth_query: z.string().optional() })
const DisconnectBody = z.object({ id: z.string() })

async function audit(db: Db, orgId: string, userId: string, sessionId: string, action: string, details: Record<string, unknown>): Promise<void> {
  await withOrg(db, orgId, (tx) =>
    tx.insert(schema.auditEvent).values({ orgId, surface: 'web', userId, action, input: null, decision: null, outcome: 'changed', details: { sessionId, ...details } }),
  )
}

/** A granted connection is audited (§6C.6). */
export async function auditConsent(db: Db, ctx: HookContext & { body?: unknown; context: { returned?: unknown } }): Promise<void> {
  if (ctx.context.returned instanceof APIError) return
  const body = ConsentBody.safeParse(ctx.body)
  if (!body.success || body.data.accept !== true) return
  const session = await sessionOf(ctx)
  const orgId = session?.session.activeOrganizationId
  if (!session || !orgId) return
  const query = new URLSearchParams(body.data.oauth_query ?? '')
  await audit(db, orgId, session.user.id, session.session.id, 'oauth.connect', { clientId: query.get('client_id'), scopes: query.get('scope') })
}

/**
 * Disconnecting an app ends it now: Better Auth only deletes the consent, so
 * its refresh tokens are revoked here, and every MCP call checks the consent
 * still exists (see base.ts), which covers access tokens already issued.
 */
export async function revokeOnDisconnect(db: Db, ctx: HookContext & { body?: unknown }): Promise<void> {
  const session = await sessionOf(ctx)
  const body = DisconnectBody.safeParse(ctx.body)
  if (!session || !body.success) return
  const { oauthConsent, oauthRefreshToken } = schema
  const [consent] = await db
    .select({ clientId: oauthConsent.clientId, orgId: oauthConsent.referenceId })
    .from(oauthConsent)
    .where(and(eq(oauthConsent.id, body.data.id), eq(oauthConsent.userId, session.user.id)))
  if (!consent) return
  await db
    .update(oauthRefreshToken)
    .set({ revoked: new Date() })
    .where(and(eq(oauthRefreshToken.userId, session.user.id), eq(oauthRefreshToken.clientId, consent.clientId), isNull(oauthRefreshToken.revoked)))
  if (consent.orgId) await audit(db, consent.orgId, session.user.id, session.session.id, 'oauth.disconnect', { clientId: consent.clientId })
}
