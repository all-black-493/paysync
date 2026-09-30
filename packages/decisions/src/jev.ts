import { z } from 'zod'

/** Pinned: thresholds are calibrated per model version; `jev-latest` moves without notice. */
export const JEV_MODEL = 'jev-1.13.0'
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

export interface ChoiceQuestion<K extends string> {
  readonly type: 'choice'
  readonly instructions: string
  readonly criteria: Readonly<Record<K, string>>
}

export interface NoulQuestion {
  readonly type: 'noul'
  readonly instructions: string
  readonly criteria?: { readonly true: string; readonly false: string }
}

export type Question = ChoiceQuestion<string> | NoulQuestion

export interface ChoiceAnswer<K extends string> {
  readonly choice: K
  readonly confidence: number
  readonly probabilities: Readonly<Record<K, number>>
}

/** Noul answers are a single probability of "yes"; there is no confidence field. */
export type NoulAnswer = number

type AnswerFor<Q> = Q extends ChoiceQuestion<infer K> ? ChoiceAnswer<K> : Q extends NoulQuestion ? NoulAnswer : never
export type Answers<Qs extends Record<string, Question>> = { readonly [N in keyof Qs]: AnswerFor<Qs[N]> }

export interface JevResult<Qs extends Record<string, Question>> {
  readonly model: string
  readonly answers: Answers<Qs>
  readonly latencyMs: number
}

export type JevFailure = 'timeout' | 'unauthorized' | 'rate_limited' | 'rejected' | 'unavailable' | 'invalid_response' | 'network' | 'not_configured'

/** Anything that stops a usable answer. Callers fail closed on every kind. */
export class JevError extends Error {
  readonly kind: JevFailure
  readonly status: number | null

  constructor(kind: JevFailure, message: string, status: number | null = null) {
    super(message)
    this.name = 'JevError'
    this.kind = kind
    this.status = status
  }
}

export interface Jev {
  ask<Qs extends Record<string, Question>>(state: unknown, questions: Qs, options: { readonly timeoutMs: number }): Promise<JevResult<Qs>>
}

export interface JevClientOptions {
  readonly apiKey: string
  readonly endpoint?: string
  readonly model?: string
  readonly fetch?: typeof fetch
  readonly now?: () => number
}

const Probability = z.number().min(0).max(1)
const RawAnswer = z.object({
  type: z.enum(['choice', 'noul', 'score']),
  choice: z.string().optional(),
  confidence: Probability.optional(),
  probabilities: z.record(z.string(), Probability).optional(),
  noul: Probability.optional(),
})
const RawResponse = z.object({ model: z.string(), answers: z.record(z.string(), RawAnswer) })

function statusFailure(status: number): JevFailure {
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 429) return 'rate_limited'
  if (status === 422 || status === 400) return 'rejected'
  return 'unavailable'
}

/** Every answer present, of the asked type, and a choice among the offered keys. */
function readAnswers<Qs extends Record<string, Question>>(questions: Qs, raw: z.infer<typeof RawResponse>['answers']): Answers<Qs> {
  const out: Record<string, unknown> = {}
  for (const [name, question] of Object.entries(questions)) {
    const answer = raw[name]
    if (answer?.type !== question.type) throw new JevError('invalid_response', `answer ${name} missing or of the wrong type`)
    if (question.type === 'noul') {
      if (answer.noul === undefined) throw new JevError('invalid_response', `answer ${name} has no noul value`)
      out[name] = answer.noul
      continue
    }
    const keys = Object.keys(question.criteria)
    const { choice, confidence, probabilities } = answer
    if (choice === undefined || !keys.includes(choice) || confidence === undefined || probabilities === undefined) {
      throw new JevError('invalid_response', `answer ${name} is not a choice among the offered options`)
    }
    out[name] = { choice, confidence, probabilities: Object.fromEntries(keys.map((k) => [k, probabilities[k] ?? 0])) }
  }
  return out as Answers<Qs>
}

/** TypeSafe's System One HTTP API (docs.typesafe.ai/api). The only place that calls Jev. */
export function createJevClient(options: JevClientOptions): Jev {
  const doFetch = options.fetch ?? fetch
  const now = options.now ?? Date.now
  return {
    async ask(state, questions, { timeoutMs }) {
      const started = now()
      let response: Response
      try {
        response = await doFetch(options.endpoint ?? JEV_ENDPOINT, {
          method: 'POST',
          headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: options.model ?? JEV_MODEL, state, questions }),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
        throw new JevError(timedOut ? 'timeout' : 'network', timedOut ? `no answer within ${String(timeoutMs)} ms` : 'could not reach TypeSafe')
      }
      if (!response.ok) throw new JevError(statusFailure(response.status), `TypeSafe answered ${String(response.status)}`, response.status)
      let body: unknown
      try {
        body = await response.json()
      } catch {
        throw new JevError('invalid_response', 'TypeSafe answered with something other than JSON')
      }
      const parsed = RawResponse.safeParse(body)
      if (!parsed.success) throw new JevError('invalid_response', 'TypeSafe answered in an unexpected shape')
      return { model: parsed.data.model, answers: readAnswers(questions, parsed.data.answers), latencyMs: now() - started }
    },
  }
}

/** Used when no TypeSafe key is configured: every question fails, and callers fall back. */
export const JEV_NOT_CONFIGURED: Jev = {
  ask() {
    return Promise.reject(new JevError('not_configured', 'Jev is not configured'))
  },
}

/** The Jev the app runs with: a real client when switched on with a key, otherwise one that always fails closed. */
export function jevFromConfig(config: { readonly JEV_ENABLED: boolean; readonly TYPESAFE_API_KEY?: string | undefined }): Jev {
  return config.JEV_ENABLED && config.TYPESAFE_API_KEY ? createJevClient({ apiKey: config.TYPESAFE_API_KEY }) : JEV_NOT_CONFIGURED
}
