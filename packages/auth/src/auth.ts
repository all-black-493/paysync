import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { schema, type Db } from '@paysync/db'
import { betterAuth } from 'better-auth'
import { asc, eq } from 'drizzle-orm'
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
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const [first] = await options.db
              .select({ organizationId: schema.member.organizationId })
              .from(schema.member)
              .where(eq(schema.member.userId, session.userId))
              .orderBy(asc(schema.member.createdAt))
              .limit(1)
            return { data: { ...session, activeOrganizationId: first?.organizationId ?? null } }
          },
        },
      },
    },
  })
}

export type Auth = ReturnType<typeof createAuth>
