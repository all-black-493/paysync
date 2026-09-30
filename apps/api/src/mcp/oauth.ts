import { APIError } from 'better-auth/api'
import { z } from 'zod'

/** What an MCP client can ask for. There is no scope that approves anything (§6C.5). */
export const MCP_SCOPES = ['openid', 'profile', 'offline_access', 'paysync:read', 'paysync:write'] as const

export const READ_SCOPE = 'paysync:read'
export const WRITE_SCOPE = 'paysync:write'

/** The MCP protected resource: token audience and the `/mcp` endpoint itself. */
export function mcpResourceUrl(publicUrl: string): string {
  return `${publicUrl}/mcp`
}

const ConsentSession = z.object({ activeOrganizationId: z.string().min(1) })

/** A token is for the organization active when the person consented, never one the client names. */
export function orgForConsent(session: unknown): string {
  const parsed = ConsentSession.safeParse(session)
  if (!parsed.success) throw new APIError('FORBIDDEN', { message: 'Select an organization before connecting an app.' })
  return parsed.data.activeOrganizationId
}

/** The claims Paysync relies on in a verified MCP access token. */
export const McpClaims = z.object({
  sub: z.string().min(1),
  org: z.string().min(1),
  azp: z.string().min(1).optional(),
  client_id: z.string().min(1).optional(),
  scope: z.string().default(''),
  exp: z.number().optional(),
})

export type McpClaims = z.infer<typeof McpClaims>

export const clientIdOf = (claims: McpClaims): string => claims.azp ?? claims.client_id ?? 'unknown'

export const scopesOf = (claims: McpClaims): string[] => claims.scope.split(' ').filter(Boolean)
