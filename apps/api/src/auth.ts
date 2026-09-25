import { apiKey } from '@better-auth/api-key'
import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { schema, type Db } from '@paysync/db'
import { betterAuth, type BetterAuthOptions } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { and, asc, eq, gt, sql } from 'drizzle-orm'
import { z } from 'zod'
import { organization } from 'better-auth/plugins'
import { ac, roles } from '@paysync/auth'

export const API_KEY_CONFIG = 'integrator'
export const API_KEY_PREFIX = 'psk_'

export interface AuthOptions {
  readonly db: Db
  readonly secret: string
  /** Public origin the browser uses, e.g. https://pay.example.com */
  readonly baseURL: string
}

const DAY_MS = 24 * 60 * 60 * 1000
const SignUpBody = z.object({ email: z.string() })

function authOptions(options: AuthOptions) {
  const secure = options.baseURL.startsWith('https://')
  return {
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
    plugins: [
      organization({ ac, roles, creatorRole: 'owner' }),
      apiKey([
        {
          configId: API_KEY_CONFIG,
          references: 'organization',
          defaultPrefix: API_KEY_PREFIX,
          requireName: true,
          enableSessionForAPIKeys: false,
          keyExpiration: { defaultExpiresIn: 90 * DAY_MS, maxExpiresIn: 365 },
          rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 600 },
        },
      ]),
    ],
    hooks: {
      // Invite-only: an HTTP sign-up needs a pending invitation for that email.
      // Trusted server code (seed, tests) calls auth.api directly and has no request.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/sign-up/email' || !ctx.request) return
        const email = SignUpBody.safeParse(ctx.body).data?.email ?? ''
        const [invited] = await options.db
          .select({ id: schema.invitation.id })
          .from(schema.invitation)
          .where(
            and(
              sql`lower(${schema.invitation.email}) = lower(${email})`,
              eq(schema.invitation.status, 'pending'),
              gt(schema.invitation.expiresAt, new Date()),
            ),
          )
          .limit(1)
        if (!invited) throw new APIError('FORBIDDEN', { message: 'Sign-up is by invitation only.' })
      }),
    },
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
  } satisfies BetterAuthOptions
}

export type Auth = ReturnType<typeof betterAuth<ReturnType<typeof authOptions>>>

export function createAuth(options: AuthOptions): Auth {
  return betterAuth(authOptions(options))
}
