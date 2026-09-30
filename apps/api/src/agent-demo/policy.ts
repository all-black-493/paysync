import { z } from 'zod'

/**
 * A scripted stand-in for an LLM (no credits needed): it reads the tool
 * results so far and picks the next call, the way a careful bookkeeping
 * agent would. It only ever uses the tools and inputs a real model gets.
 */

export interface Step {
  readonly toolCallId: string
  readonly toolName: string
  readonly input: unknown
  /** Absent while the call waits for the person's chat-level confirmation. */
  readonly output?: unknown
}

export type Next = { readonly kind: 'call'; readonly toolName: string; readonly input: Record<string, unknown> } | { readonly kind: 'answer'; readonly text: string }

export interface PolicyOptions {
  readonly sessionId: string
  /** Write-offs at or below this (minor units) are worth asking for. */
  readonly writeOffLimitMinor: bigint
}

const Money = z.object({ minor: z.string(), currency: z.string() })
const Exception = z.object({ id: z.string(), kind: z.string(), version: z.number(), transactionId: z.string().nullable(), summary: z.string() })
const ExceptionPage = z.object({ items: z.array(Exception) })
const Transaction = z.object({ id: z.string(), version: z.number(), receiptNumber: z.string(), unallocated: Money })
const Suggestions = z.object({
  transaction: Transaction,
  suggestions: z.array(z.object({ expectedPayment: z.object({ id: z.string(), reference: z.string() }), reasons: z.array(z.string()), amount: Money })),
})
const Outcome = z.object({ status: z.string(), pendingActionId: z.string().optional(), approvalsRequired: z.number().optional(), reason: z.string().optional() })
const Changed = z.object({ changed: z.boolean() })

const REFERENCE_FITS = new Set(['same_reference', 'same_reference_normalized'])
const MATCHABLE = new Set(['no_match', 'low_confidence', 'overpayment'])

const kes = (minor: bigint) => `KES ${(minor / 100n).toLocaleString('en-KE')}.${(minor % 100n).toString().padStart(2, '0')}`

function results(history: readonly Step[], toolName: string) {
  return history.filter((s) => s.toolName === toolName)
}

function called(history: readonly Step[], toolName: string, match: (input: Record<string, unknown>) => boolean): Step | undefined {
  return results(history, toolName).find((s) => typeof s.input === 'object' && s.input !== null && match(s.input as Record<string, unknown>))
}

/** What happened to one tool call, in words for the closing summary. */
function outcomeOf(step: Step | undefined): string {
  if (!step) return 'not tried'
  const outcome = Outcome.safeParse(step.output)
  if (outcome.success && outcome.data.status === 'waiting_for_approval') {
    return `waiting for ${outcome.data.approvalsRequired === 2 ? 'two approvers' : 'an approver'} (request ${outcome.data.pendingActionId ?? ''})`
  }
  if (outcome.success && outcome.data.status !== 'waiting_for_approval') return `${outcome.data.status}${outcome.data.reason ? `: ${outcome.data.reason}` : ''}`
  return Changed.safeParse(step.output).success ? 'done' : 'no answer yet'
}

export function nextStep(history: readonly Step[], options: PolicyOptions): Next {
  const key = (action: string, id: string) => `demo-${options.sessionId}-${action}-${id}`.slice(0, 200)
  const listed = results(history, 'list_exceptions')[0]
  if (!listed) return { kind: 'call', toolName: 'list_exceptions', input: {} }
  const page = ExceptionPage.safeParse(listed.output)
  if (!page.success) return { kind: 'answer', text: 'I could not read the exceptions list, so I stopped.' }

  const report: string[] = []
  for (const e of page.data.items) {
    if (!e.transactionId) {
      report.push(`${e.summary}: not about a payment; left for a person.`)
      continue
    }
    const transactionId = e.transactionId

    if (e.kind === 'duplicate') {
      const read = called(history, 'get_transaction', (i) => i.id === transactionId)
      if (!read) return { kind: 'call', toolName: 'get_transaction', input: { id: transactionId } }
      const payment = Transaction.safeParse(read.output)
      if (!payment.success) continue
      const reversal = called(history, 'request_reversal', (i) => i.transactionId === transactionId)
      if (!reversal) {
        return {
          kind: 'call',
          toolName: 'request_reversal',
          input: {
            transactionId,
            version: payment.data.version,
            reason: 'Paid twice for an invoice that is already settled; return this payment to the payer.',
            idempotencyKey: key('reversal', transactionId),
          },
        }
      }
      report.push(`Payment ${payment.data.receiptNumber} was paid twice: reversal requested, ${outcomeOf(reversal)}.`)
      continue
    }

    if (!MATCHABLE.has(e.kind)) {
      report.push(`${e.summary}: needs a person (${e.kind.replaceAll('_', ' ')}).`)
      continue
    }

    const suggested = called(history, 'suggest_matches', (i) => i.transactionId === transactionId)
    if (!suggested) return { kind: 'call', toolName: 'suggest_matches', input: { transactionId } }
    const found = Suggestions.safeParse(suggested.output)
    if (!found.success) continue
    const top = found.data.suggestions[0]
    const fits = top !== undefined && top.reasons.some((r) => REFERENCE_FITS.has(r))

    if (!fits) {
      const note = called(history, 'annotate_exception', (i) => i.id === e.id)
      if (!note) {
        const hint = top ? ` The closest is ${top.expectedPayment.reference} (${top.reasons.join(', ').replaceAll('_', ' ')}), but the reference does not fit.` : ''
        return {
          kind: 'call',
          toolName: 'annotate_exception',
          input: { id: e.id, version: e.version, note: `Agent: no expected payment fits this reference.${hint} A person should check.`, idempotencyKey: key('note', e.id) },
        }
      }
      report.push(`Payment ${found.data.transaction.receiptNumber}: no safe match; noted for a person.`)
      continue
    }

    const confirm = called(history, 'confirm_match', (i) => i.transactionId === transactionId)
    if (!confirm) {
      return {
        kind: 'call',
        toolName: 'confirm_match',
        input: {
          transactionId,
          version: found.data.transaction.version,
          allocations: [{ expectedPaymentId: top.expectedPayment.id, amount: top.amount }],
          idempotencyKey: key('match', transactionId),
        },
      }
    }
    report.push(`Payment ${found.data.transaction.receiptNumber} → ${top.expectedPayment.reference}: ${outcomeOf(confirm)}.`)

    if (e.kind === 'overpayment' && outcomeOf(confirm) === 'done') {
      const reread = called(history, 'get_transaction', (i) => i.id === transactionId)
      if (!reread) return { kind: 'call', toolName: 'get_transaction', input: { id: transactionId } }
      const after = Transaction.safeParse(reread.output)
      if (!after.success) continue
      const rest = BigInt(after.data.unallocated.minor)
      if (rest > 0n && rest <= options.writeOffLimitMinor) {
        const writeOff = called(history, 'write_off_variance', (i) => i.transactionId === transactionId)
        if (!writeOff) {
          return {
            kind: 'call',
            toolName: 'write_off_variance',
            input: {
              transactionId,
              version: after.data.version,
              amount: after.data.unallocated,
              reason: `Small overpayment of ${kes(rest)} left after matching; not worth refunding.`,
              idempotencyKey: key('writeoff', transactionId),
            },
          }
        }
        report.push(`The ${kes(rest)} left over: write-off requested, ${outcomeOf(writeOff)}.`)
      }
    }
  }
  return { kind: 'answer', text: ['Done with the open exceptions:', ...report.map((r) => `- ${r}`)].join('\n') }
}
