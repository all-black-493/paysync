import { CONSTRAINTS, SQLSTATE, pgConstraint, pgErrorCode, schema, withOrg } from '@paysync/db'
import { DEFAULT_GUARD_POLICY, decide, needsJudgement, type GuardDecision } from '@paysync/guard'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { mutate, type Preview } from '../mutate.js'
import { auditDecision, tooManyWrites } from './audit.js'
import { approvalRequired, mapActionError } from './errors.js'
import { judge } from './judge.js'
import { agentMetaFor } from './procedure-meta.js'
import { actorOf, type GuardContext, type GuardErrors, type GuardedAction, type GuardedInput } from './types.js'

const { pendingAction } = schema

const isPerson = (context: GuardContext) => context.caller.kind === 'user' && (context.surface === 'web' || context.surface === 'rest')

/**
 * The guard for one call (AGENTS.md §8.3): rate limit, an earlier request with
 * this idempotency key, deterministic checks and budget, the decision, then
 * allow (run once), block, or store the request with a dry-run preview and
 * answer APPROVAL_REQUIRED.
 */
export async function runGuarded<I extends GuardedInput, R>(
  context: GuardContext,
  action: GuardedAction<I, R>,
  input: I,
  errors: GuardErrors,
): Promise<Preview<R>> {
  const policy = context.policy ?? DEFAULT_GUARD_POLICY
  const { caller, db } = context
  const meta = agentMetaFor(action.procedure)
  const output = z.object({ dryRun: z.boolean(), changed: z.boolean(), result: action.result }) as z.ZodType<Preview<R>>
  const runDirect = (decision: GuardDecision, dryRun: boolean, jev?: Record<string, unknown>) =>
    mutate({
      db,
      caller,
      surface: context.surface,
      action: action.procedure,
      input: { ...input, dryRun },
      output,
      ...(action.isolation ? { isolation: action.isolation } : {}),
      decision: dryRun ? 'dry_run' : decision.kind,
      reasons: decision.reasons,
      ...(jev ? { evidence: { jev } } : {}),
      ...(context.agent?.sessionId ? { agentSessionId: context.agent.sessionId } : {}),
      run: (tx) => action.run(tx, input, actorOf(caller)),
    }).catch((error: unknown) => mapActionError(errors, error))

  if (!input.dryRun && (await tooManyWrites(context, policy))) throw errors.RATE_LIMITED()

  const [earlier] = await withOrg(db, caller.orgId, (tx) =>
    tx
      .select()
      .from(pendingAction)
      .where(and(eq(pendingAction.orgId, caller.orgId), eq(pendingAction.idempotencyKey, input.idempotencyKey))),
  )
  if (earlier && !input.dryRun) {
    if (earlier.status === 'pending') throw approvalRequired(errors, earlier)
    if (earlier.status === 'executed') return runDirect({ kind: 'allow', reasons: [] }, false)
    if (errors.INVALID_STATE) throw errors.INVALID_STATE({ data: { status: `request_${earlier.status}` } })
    throw errors.BLOCKED({ data: { reason: `this request was ${earlier.status}` } })
  }

  const facts = await withOrg(db, caller.orgId, async (tx) => ({
    summary: await action.summary(tx, input),
    checks: (await action.checks?.(tx, input, caller, policy)) ?? { blocks: [], doubts: [] },
    overBudget: (await action.overBudget?.(tx, input, policy)) ?? null,
    records: needsJudgement(meta, context.surface) ? ((await action.records?.(tx, input)) ?? null) : null,
  })).catch((error: unknown) => mapActionError(errors, error))

  // Asked after the read transaction closed: never call Jev with a transaction open (§6B.5).
  const judged = needsJudgement(meta, context.surface) ? await judge(context, action.procedure, facts.summary, input, facts.records, policy) : undefined
  const jev = judged?.evidence
  const decision = decide({
    meta,
    surface: context.surface,
    actor: isPerson(context) ? 'person' : 'machine',
    checks: facts.checks,
    production: false,
    thresholds: policy.jev,
    ...(judged ? { judgement: judged.judgement } : {}),
  })

  if (decision.kind === 'block' || facts.overBudget) {
    await withOrg(db, caller.orgId, (tx) =>
      auditDecision(tx, context, action.procedure, input, decision.kind === 'block' ? 'block' : 'budget_exceeded', 'refused', {
        reasons: decision.reasons,
        budget: facts.overBudget,
        ...(jev ? { jev } : {}),
      }),
    )
    if (decision.kind === 'block') throw errors.BLOCKED({ data: { reason: decision.reasons.join('; ') } })
    if (facts.overBudget) throw errors.BUDGET_EXCEEDED({ data: facts.overBudget })
  }

  if (decision.kind === 'allow' || input.dryRun) return runDirect(decision, input.dryRun === true, jev)

  const preview = await runDirect(decision, true, jev)
  const { approvalsRequired } = decision
  const { idempotencyKey } = input
  // Stored exactly as it will run on approval (with its idempotency key, without dryRun).
  const request = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'dryRun'))
  try {
    const created = await withOrg(db, caller.orgId, async (tx) => {
      const [row] = await tx
        .insert(pendingAction)
        .values({
          orgId: caller.orgId,
          procedure: action.procedure,
          risk: meta?.risk ?? 'destructive',
          money: meta?.money ?? false,
          input: request,
          summary: facts.summary.slice(0, 500),
          preview: preview.result,
          reasons: [...decision.reasons],
          requestedBy: caller.actorId,
          requesterKind: caller.kind,
          surface: context.surface,
          idempotencyKey,
          approvalsRequired,
          expiresAt: new Date(Date.now() + policy.approvalTtlMs),
        })
        .returning()
      if (!row) throw new Error('pending action insert returned no row')
      await auditDecision(tx, context, action.procedure, input, 'require_approval', 'pending', {
        pendingActionId: row.id,
        reasons: decision.reasons,
        ...(jev ? { jev } : {}),
      })
      return row
    })
    throw approvalRequired(errors, created)
  } catch (error) {
    if (pgErrorCode(error) === SQLSTATE.uniqueViolation && pgConstraint(error) === CONSTRAINTS.pendingActionKey) {
      const [existing] = await withOrg(db, caller.orgId, (tx) =>
        tx.select().from(pendingAction).where(and(eq(pendingAction.orgId, caller.orgId), eq(pendingAction.idempotencyKey, idempotencyKey))),
      )
      if (existing) throw approvalRequired(errors, existing)
    }
    throw error
  }
}
