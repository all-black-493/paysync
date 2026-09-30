import { ORPCError, streamToEventIterator } from '@orpc/server'
import { schema, withOrg } from '@paysync/db'
import { convertToModelMessages, isStepCount, safeValidateUIMessages, streamText, toUIMessageStream, type UIMessage } from 'ai'
import { and, count, eq, gt, sql } from 'drizzle-orm'
import { authed } from '../orpc/base.js'
import { ASSISTANT_INSTRUCTIONS } from './assistant.js'
import { agentTools } from './tools.js'

/** The newest turns only: older history costs tokens without helping the next step. */
const HISTORY = 20

function lastUserText(messages: readonly UIMessage[]): string | null {
  const last = [...messages].reverse().find((m) => m.role === 'user')
  const text = last?.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n').trim()
  return text ? text.slice(0, 2000) : null
}

/**
 * assistant.chat: the in-app agent (§4.1). The person's own session drives
 * every tool call, so the assistant can do nothing they could not; each turn
 * is audited, rate limited and capped in steps and tokens.
 */
export const assistantChat = authed.assistant.chat.handler(async ({ context, input, errors, signal }) => {
  const { caller, assistant } = context
  if (!assistant) throw errors.ASSISTANT_OFF()
  if (context.surface !== 'web' || caller.kind !== 'user' || !caller.session) throw new ORPCError('FORBIDDEN', { message: 'The assistant is for people signed in to the web app.' })

  const recent = await withOrg(context.db, caller.orgId, async (tx) => {
    const [row] = await tx
      .select({ n: count() })
      .from(schema.auditEvent)
      .where(and(eq(schema.auditEvent.userId, caller.actorId), eq(schema.auditEvent.action, 'assistant.chat'), gt(schema.auditEvent.occurredAt, sql`now() - interval '1 hour'`)))
    return row?.n ?? 0
  })
  if (recent >= assistant.turnsPerHour) throw errors.RATE_LIMITED()

  const unreadable = () => new ORPCError('BAD_REQUEST', { message: 'The conversation could not be read. Start a new one.' })
  const sessionId = `chat-${input.chatId}`
  // Read once for the person's latest words (Jev compares writes to them), then again against the tools.
  const draft = await safeValidateUIMessages({ messages: input.messages })
  if (!draft.success) throw unreadable()
  const { tools, toolApproval } = agentTools({
    services: { auth: context.auth, db: context.db, logger: context.logger, jev: context.jev },
    headers: context.reqHeaders ?? new Headers(),
    sessionId,
    userRequest: lastUserText(draft.data),
  })
  const messages = await safeValidateUIMessages({ messages: input.messages, tools })
  if (!messages.success) throw unreadable()

  await withOrg(context.db, caller.orgId, (tx) =>
    tx.insert(schema.auditEvent).values({
      orgId: caller.orgId,
      surface: 'web',
      userId: caller.actorId,
      agentSessionId: sessionId,
      action: 'assistant.chat',
      input: { chatId: input.chatId, messages: messages.data.length },
      outcome: 'answered',
      details: { sessionId: caller.session?.id ?? null },
    }),
  )

  const result = streamText({
    model: assistant.model,
    instructions: ASSISTANT_INSTRUCTIONS,
    messages: await convertToModelMessages(messages.data.slice(-HISTORY), { tools, ignoreIncompleteToolCalls: true }),
    tools,
    toolApproval,
    experimental_toolApprovalSecret: assistant.approvalSecret,
    stopWhen: isStepCount(assistant.maxSteps),
    maxOutputTokens: assistant.maxOutputTokens,
    ...(signal ? { abortSignal: signal } : {}),
    onEnd: ({ usage }) => {
      context.logger.info({ sessionId, usage }, 'assistant turn')
    },
  })
  return streamToEventIterator(toUIMessageStream({ stream: result.stream, tools, originalMessages: messages.data }))
})
