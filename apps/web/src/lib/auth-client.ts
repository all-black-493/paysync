import { ac, roles } from '@paysync/auth'
import { organizationClient, twoFactorClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'

export const authClient = createAuthClient({
  baseURL: typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
  basePath: '/api/auth',
  // The code step is shown in place (sign-in and step-up), not on a separate page.
  plugins: [organizationClient({ ac, roles, dynamicAccessControl: { enabled: true } }), twoFactorClient()],
})

/** True when a password sign-in still needs the TOTP code. */
export function needsSecondFactor(data: unknown): boolean {
  return typeof data === 'object' && data !== null && 'twoFactorRedirect' in data && data.twoFactorRedirect === true
}
