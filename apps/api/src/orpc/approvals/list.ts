import { schema, withOrg } from '@paysync/db'
import { and, desc, eq, lt } from 'drizzle-orm'
import { authed } from '../base.js'
import { pageOf } from '../mappers.js'
import { expireOld, toPendingAction } from './view.js'

const { pendingAction } = schema

export const pendingActionsList = authed.pendingActions.list.handler(async ({ context, input }) =>
  withOrg(context.db, context.caller.orgId, async (tx) => {
    await expireOld(tx)
    const rows = await tx
      .select()
      .from(pendingAction)
      .where(and(eq(pendingAction.status, input.status), input.cursor ? lt(pendingAction.id, input.cursor) : undefined))
      .orderBy(desc(pendingAction.id))
      .limit(input.limit + 1)
    return pageOf(await Promise.all(rows.map((r) => toPendingAction(tx, r))), input.limit)
  }),
)

export const pendingActionsGet = authed.pendingActions.get.handler(async ({ context, input, errors }) =>
  withOrg(context.db, context.caller.orgId, async (tx) => {
    await expireOld(tx)
    const [row] = await tx.select().from(pendingAction).where(eq(pendingAction.id, input.id))
    if (!row) throw errors.NOT_FOUND()
    return toPendingAction(tx, row)
  }),
)
