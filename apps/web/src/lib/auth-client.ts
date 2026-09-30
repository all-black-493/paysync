import { ac, roles } from '@paysync/auth'
import { oauthProviderClient } from '@better-auth/oauth-provider/client'
import type { BetterAuthClientPlugin } from 'better-auth/client'
import { organizationClient, twoFactorClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'

/**
 * True on a page an OAuth authorization sent us to (sign-in or consent): its
 * signed query must ride along on this page's auth requests, and Better Auth
 * then continues the authorization itself. Pages load fully, so this is fixed per page.
 */
export const inOAuthFlow = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('sig')

const oauthQuery = {
  id: 'oauth-query',
  fetchPlugins: inOAuthFlow ? oauthProviderClient().fetchPlugins : [],
} satisfies BetterAuthClientPlugin

export const authClient = createAuthClient({
  baseURL: typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
  basePath: '/api/auth',
  // The code step is shown in place (sign-in and step-up), not on a separate page.
  plugins: [organizationClient({ ac, roles, dynamicAccessControl: { enabled: true } }), twoFactorClient(), oauthQuery],
})

/** True when a password sign-in still needs the TOTP code. */
export function needsSecondFactor(data: unknown): boolean {
  return typeof data === 'object' && data !== null && 'twoFactorRedirect' in data && data.twoFactorRedirect === true
}
