import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import type { Db } from '@paysync/db'
import { betterAuth } from 'better-auth'
import { organization } from 'better-auth/plugins'
import { ac, roles } from './permissions.js'

export interface AuthOptions {
  readonly db: Db
  readonly secret: string
  /** Public origin the browser uses, e.g. https://pay.example.com */
  readonly baseURL: string
}

export function createAuth(options: AuthOptions) {
  const secure = options.baseURL.startsWith('https://')
  return betterAuth({
    appName: 'Paysync',
    secret: options.secret,
    baseURL: options.baseURL,
    basePath: '/api/auth',
    trustedOrigins: [options.baseURL],
    database: drizzleAdapter(options.db, { provider: 'pg', schemaName: 'auth' }),
    emailAndPassword: { enabled: true, minPasswordLength: 12 },
    rateLimit: { enabled: true, storage: 'database' },
    advanced: {
      cookiePrefix: 'paysync',
      useSecureCookies: secure,
      defaultCookieAttributes: { sameSite: 'lax', httpOnly: true, secure },
    },
    plugins: [organization({ ac, roles, creatorRole: 'owner' })],
  })
}

export type Auth = ReturnType<typeof createAuth>
