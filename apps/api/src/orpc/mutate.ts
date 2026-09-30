import { createHash } from 'node:crypto'
import { CONSTRAINTS, SQLSTATE, pgConstraint, pgErrorCode, schema, withOrg, type Db, type Tx } from '@paysync/db'
import { ORPCError } from '@orpc/server'
import { and, eq, sql } from 'drizzle-orm'
import type { z } from 'zod'
import type { Caller, Surface } from './base.js'

export interface Preview<T> {
  readonly dryRun: boolean
  readonly changed: boolean
  readonly result: T
}

class DryRunRollback<T> extends Error {
  readonly preview: Preview<T>
  constructor(preview: Preview<T>) {
    super('dry run')
    this.preview = preview
  }
}

const REDACTED_INPUT_FIELDS = new Set(['payerLabel'])

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    )
  }
  return value
}

export function requestHash(request: Record<string, unknown>): string {
  const significant = Object.fromEntries(Object.entries(request).filter(([k]) => k !== 'idempotencyKey' && k !== 'dryRun'))
  return createHash('sha256').update(JSON.stringify(canonical(significant))).digest('hex')
}

export function redact(request: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(request).map(([k, v]) => [k, REDACTED_INPUT_FIELDS.has(k) ? '[redacted]' : v]))
}

export interface MutationOptions<T> {
  readonly db: Db
  readonly caller: Caller
  readonly surface: Surface
  readonly action: string
  readonly input: Record<string, unknown> & { readonly idempotencyKey: string; readonly dryRun: boolean }
  /** Output schema, used to re-validate a stored response on idempotent replay. */
  readonly output: z.ZodType<Preview<T>>
  readonly run: (tx: Tx) => Promise<{ readonly result: T; readonly changed: boolean }>
  /** What to keep for idempotent replay; strip one-time secrets here. */
  readonly stored?: (preview: Preview<T>) => Preview<T>
  /** Serializable for allocation paths; retried on serialization failures. */
  readonly isolation?: 'read committed' | 'serializable'
  /** The guard's decision and reasons, for the audit log. */
  readonly decision?: string
  readonly reasons?: readonly string[]
  /** Extra decision evidence for the audit log, e.g. Jev's answers (§8.5). */
  readonly evidence?: Record<string, unknown>
}

/**
 * Runs a write once per idempotency key, inside the caller's organization.
 * dryRun executes the same SQL, checks deferred constraints, then rolls back.
 */
export async function mutate<T>(options: MutationOptions<T>): Promise<Preview<T>> {
  const { caller, input } = options
  const hash = requestHash(input)

  const replay = async (tx: Tx): Promise<Preview<T> | undefined> => {
    const [record] = await tx
      .select()
      .from(schema.idempotencyRecord)
      .where(and(eq(schema.idempotencyRecord.orgId, caller.orgId), eq(schema.idempotencyRecord.key, input.idempotencyKey)))
    if (!record) return undefined
    if (record.action !== options.action || record.requestHash !== hash) {
      throw new ORPCError('IDEMPOTENCY_CONFLICT', {
        message: 'This idempotency key was already used for a different request.',
      })
    }
    return options.output.parse(record.response)
  }

  const attempt = () =>
    withOrg(options.db, caller.orgId, async (tx) => {
      if (!input.dryRun) {
        const previous = await replay(tx)
        if (previous) return previous
      }
      const { result, changed } = await options.run(tx)
      const preview: Preview<T> = { dryRun: input.dryRun, changed, result }
      if (input.dryRun) {
        await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`)
        throw new DryRunRollback(preview)
      }
      await tx.insert(schema.idempotencyRecord).values({
        orgId: caller.orgId,
        key: input.idempotencyKey,
        action: options.action,
        requestHash: hash,
        response: options.stored ? options.stored(preview) : preview,
      })
      await tx.insert(schema.auditEvent).values({
        orgId: caller.orgId,
        surface: options.surface,
        userId: caller.actorId,
        agentSessionId: caller.agentSessionId,
        action: options.action,
        input: redact(input),
        decision: options.decision ?? 'allow',
        outcome: changed ? 'changed' : 'unchanged',
        details: { sessionId: caller.session?.id ?? null, reasons: options.reasons ?? [], ...options.evidence },
      })
      return preview
    }, { isolation: options.isolation ?? 'read committed' })

  try {
    return await attempt()
  } catch (error) {
    if (error instanceof DryRunRollback) return error.preview as Preview<T>
    // A concurrent request with the same key committed first: return its result.
    if (pgErrorCode(error) === SQLSTATE.uniqueViolation && pgConstraint(error) === CONSTRAINTS.idempotencyKey) {
      const previous = await withOrg(options.db, caller.orgId, replay)
      if (previous) return previous
    }
    throw error
  }
}
