import { MockLanguageModelV4 } from 'ai/test'
import { nextStep, type PolicyOptions, type Step } from './policy.js'

type CallOptions = Parameters<MockLanguageModelV4['doGenerate']>[0]
type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>

const usage: GenerateResult['usage'] = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
}

/** Tool calls and their results so far, from the prompt the AI SDK sends the model. */
export function historyOf(prompt: CallOptions['prompt']): Step[] {
  const steps = new Map<string, { toolCallId: string; toolName: string; input: unknown; output?: unknown }>()
  for (const message of prompt) {
    if (message.role === 'assistant') {
      for (const part of message.content) {
        if (part.type === 'tool-call') steps.set(part.toolCallId, { toolCallId: part.toolCallId, toolName: part.toolName, input: part.input })
      }
    }
    if (message.role === 'tool') {
      for (const part of message.content) {
        if (part.type !== 'tool-result') continue
        const step = steps.get(part.toolCallId)
        if (step) step.output = part.output.type === 'json' || part.output.type === 'text' ? part.output.value : part.output
      }
    }
  }
  return [...steps.values()]
}

/** An AI SDK language model driven by the scripted policy: the real tool loop, without an LLM. */
export function scriptedModel(options: PolicyOptions): MockLanguageModelV4 {
  let calls = 0
  return new MockLanguageModelV4({
    provider: 'paysync',
    modelId: 'scripted-bookkeeper',
    doGenerate: (call) => {
      const next = nextStep(historyOf(call.prompt), options)
      calls += 1
      if (next.kind === 'answer') {
        return Promise.resolve({ content: [{ type: 'text', text: next.text }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] })
      }
      return Promise.resolve({
        content: [{ type: 'tool-call', toolCallId: `call-${String(calls)}`, toolName: next.toolName, input: JSON.stringify(next.input) }],
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
        usage,
        warnings: [],
      })
    },
  })
}
