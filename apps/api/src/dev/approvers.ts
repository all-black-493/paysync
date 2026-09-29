import { schema, type Db } from '@paysync/db'
import type { Logger } from '@paysync/platform'
import { eq } from 'drizzle-orm'
import type { Auth } from '../auth.js'
import { secretFromUri, totpCode } from './totp.js'

/**
 * Dev seed only: turns on TOTP for demo approvers through Better Auth's own
 * endpoints and logs each secret once, so the approval flow can be tried.
 */
export async function enrollDemoApprovers(auth: Auth, db: Db, emails: readonly string[], password: string, logger: Logger): Promise<void> {
  for (const email of emails) {
    const [user] = await db.select({ enabled: schema.user.twoFactorEnabled }).from(schema.user).where(eq(schema.user.email, email))
    if (!user || user.enabled === true) continue
    const { headers } = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true })
    const cookie = headers
      .getSetCookie()
      .map((c) => c.split(';', 1)[0])
      .join('; ')
    const session = new Headers({ cookie })
    const enabled = await auth.api.enableTwoFactor({ body: { password }, headers: session })
    if (enabled.method !== 'totp') throw new Error('expected TOTP enrollment')
    const secret = secretFromUri(enabled.totpURI)
    await auth.api.verifyTOTP({ body: { code: totpCode(secret) }, headers: session })
    logger.info({ email, totpSecret: secret }, 'dev approver has two-factor authentication; add this secret to an authenticator app')
  }
}
