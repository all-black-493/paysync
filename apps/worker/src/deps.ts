import type { DarajaClient, DarajaEnvironment, ResultUrls } from '@paysync/daraja'
import type { Db } from '@paysync/db'
import type { MatchPolicy } from '@paysync/matching'
import type { Logger, Sealer } from '@paysync/platform'

export interface VerificationPolicy {
  /** Pending transactions older than this are re-verified by the sweep. */
  readonly retryAfterMs: number
  /** After this many attempts the sweep stops and a human is asked to look. */
  readonly maxAttempts: number
  /** STK pushes without a callback after this long are queried. */
  readonly stkQueryAfterMs: number
  readonly stkMaxQueries: number
  /** Pull Transactions only serves the last 48 hours. */
  readonly pullMaxLookbackMs: number
  /** First pull for a shortcode, and overlap with the previous window. */
  readonly pullInitialLookbackMs: number
  readonly pullOverlapMs: number
  readonly pullMaxPages: number
}

export const DEFAULT_POLICY: VerificationPolicy = {
  retryAfterMs: 5 * 60_000,
  maxAttempts: 12,
  stkQueryAfterMs: 3 * 60_000,
  stkMaxQueries: 20,
  pullMaxLookbackMs: 47 * 60 * 60_000,
  pullInitialLookbackMs: 60 * 60_000,
  pullOverlapMs: 10 * 60_000,
  pullMaxPages: 50,
}

export interface WorkerDeps {
  readonly db: Db
  readonly logger: Logger
  readonly pii: Sealer
  readonly environment: DarajaEnvironment
  readonly daraja: DarajaClient
  /** Null without a public callback URL: requests whose answer comes on a Result URL are not sent. */
  readonly resultUrls: ((kind: ResultUrlKind) => ResultUrls) | null
  readonly policy: VerificationPolicy
  readonly matchPolicy: MatchPolicy
  readonly now: () => Date
}

export type ResultUrlKind = 'txn' | 'balance' | 'reversal'

export function resultUrlsFor(baseUrl: string, secret: string) {
  const base = baseUrl.replace(/\/$/, '')
  return (kind: ResultUrlKind): ResultUrls => ({
    resultUrl: `${base}/hooks/result/${kind}/${secret}`,
    timeoutUrl: `${base}/hooks/timeout/${kind}/${secret}`,
  })
}
