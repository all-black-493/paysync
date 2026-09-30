import { randomUUID } from 'node:crypto'
import { formatTimeline, replay } from '@paysync/audit'
import { schema, withOrg } from '@paysync/db'
import { generateText, isStepCount, type ModelMessage } from 'ai'
import { eq } from 'drizzle-orm'
import { agentTools, type AgentSessionContext } from '../agent/tools.js'
import type { Auth } from '../auth.js'
import { scriptedModel } from './model.js'
import { createDemoOrg, type DemoOrg } from './setup.js'

export const DEMO_REQUEST =
  'Clear the exceptions backlog. Match what clearly belongs together, leave notes on the rest, write off overpayments under KES 100, and refund anything paid twice.'

export interface DemoReport {
  readonly org: DemoOrg
  readonly sessionId: string
  readonly openBefore: number
  readonly openAfter: number
  /** One line per tool call, in order. */
  readonly transcript: readonly string[]
  readonly answer: string
  readonly pending: ReadonlyArray<{ readonly procedure: string; readonly approvalsRequired: number; readonly summary: string }>
  readonly timeline: string
}

async function openExceptions(services: AgentSessionContext['services'], orgId: string): Promise<number> {
  const rows = await withOrg(services.db, orgId, (tx) => tx.select({ id: schema.exception.id }).from(schema.exception).where(eq(schema.exception.status, 'open')))
  return rows.length
}

function short(value: unknown): string {
  const text = JSON.stringify(value)
  return text.length > 140 ? `${text.slice(0, 137)}...` : text
}

/**
 * One scripted agent session end to end: a fresh organization with a backlog,
 * the person's sign-in, the AI SDK tool loop on the `ai-sdk` surface, the
 * person confirming destructive tools in chat, then the audit replay.
 */
export async function runAgentDemo(services: AgentSessionContext['services'] & { readonly auth: Auth }, password: string): Promise<DemoReport> {
  const org = await createDemoOrg(services.auth, services.db, password)
  const sessionId = `agent-demo-${randomUUID()}`
  const { headers: signedIn } = await services.auth.api.signInEmail({ body: { email: org.person.email, password }, returnHeaders: true })
  const cookie = signedIn
    .getSetCookie()
    .map((c) => c.split(';', 1)[0])
    .join('; ')

  const { tools, toolApproval } = agentTools({ services, headers: new Headers({ cookie }), sessionId, userRequest: DEMO_REQUEST })
  const model = scriptedModel({ sessionId, writeOffLimitMinor: 100_00n })
  const openBefore = await openExceptions(services, org.orgId)
  const transcript: string[] = []
  let messages: ModelMessage[] = [{ role: 'user', content: DEMO_REQUEST }]
  let answer = ''

  for (let round = 0; round < 10; round++) {
    const result = await generateText({ model, tools, toolApproval, messages, stopWhen: isStepCount(60) })
    messages = [...messages, ...result.responseMessages]
    for (const step of result.steps) {
      for (const r of step.toolResults) transcript.push(`${r.toolName}(${short(r.input)}) → ${short(r.output)}`)
    }
    const requests = result.content.filter((part) => part.type === 'tool-approval-request')
    if (requests.length === 0) {
      answer = result.text
      break
    }
    for (const r of requests) transcript.push(`${r.toolCall.toolName} needs the person's confirmation in chat: confirmed`)
    // The person confirms in chat; the request still goes to an approver in the web app.
    messages.push({ role: 'tool', content: requests.map((r) => ({ type: 'tool-approval-response' as const, approvalId: r.approvalId, approved: true })) })
  }

  const pending = await withOrg(services.db, org.orgId, (tx) =>
    tx
      .select({ procedure: schema.pendingAction.procedure, approvalsRequired: schema.pendingAction.approvalsRequired, summary: schema.pendingAction.summary })
      .from(schema.pendingAction)
      .where(eq(schema.pendingAction.status, 'pending')),
  )
  return {
    org,
    sessionId,
    openBefore,
    openAfter: await openExceptions(services, org.orgId),
    transcript,
    answer,
    pending,
    timeline: formatTimeline(await replay(services.db, org.orgId, { sessionId })),
  }
}
