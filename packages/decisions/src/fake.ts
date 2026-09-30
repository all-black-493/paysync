import { JevError, type Answers, type Jev, type JevFailure, type Question } from './jev.js'

export type FakeAnswer = number | { readonly choice: string; readonly confidence: number; readonly probabilities?: Readonly<Record<string, number>> }

export interface FakeJev extends Jev {
  readonly calls: Array<{ readonly state: unknown; readonly questions: Readonly<Record<string, Question>> }>
}

/**
 * A stand-in Jev for tests: answers come from `answer` (by question name), or
 * every call fails with `fail`, or takes `delayMs` and honours the timeout.
 */
export function fakeJev(options: {
  readonly answer?: (name: string, question: Question, state: unknown) => FakeAnswer
  readonly fail?: JevFailure
  readonly delayMs?: number
}): FakeJev {
  const calls: FakeJev['calls'] = []
  return {
    calls,
    async ask(state, questions, { timeoutMs }) {
      calls.push({ state, questions })
      if (options.delayMs !== undefined) {
        if (options.delayMs > timeoutMs) {
          await new Promise((resolve) => setTimeout(resolve, timeoutMs))
          throw new JevError('timeout', `no answer within ${String(timeoutMs)} ms`)
        }
        await new Promise((resolve) => setTimeout(resolve, options.delayMs))
      }
      if (options.fail) throw new JevError(options.fail, `fake failure: ${options.fail}`)
      const answers: Record<string, unknown> = {}
      for (const [name, question] of Object.entries(questions)) {
        const given = options.answer?.(name, question, state)
        if (given === undefined) throw new JevError('invalid_response', `fake has no answer for ${name}`)
        if (typeof given === 'number') {
          answers[name] = given
          continue
        }
        const keys = question.type === 'choice' ? Object.keys(question.criteria) : []
        answers[name] = { choice: given.choice, confidence: given.confidence, probabilities: given.probabilities ?? Object.fromEntries(keys.map((k) => [k, k === given.choice ? given.confidence : 0])) }
      }
      return { model: 'fake-jev', answers: answers as Answers<typeof questions>, latencyMs: options.delayMs ?? 0 }
    },
  }
}
