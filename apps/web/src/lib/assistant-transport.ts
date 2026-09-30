import { eventIteratorToUnproxiedDataStream } from '@orpc/client'
import type { ChatTransport, UIMessage } from 'ai'
import { client } from './orpc'

/** useChat over the typed oRPC client: the chat is a contract procedure like everything else. */
export const assistantTransport: ChatTransport<UIMessage> = {
  async sendMessages({ chatId, messages, abortSignal }) {
    const iterator = await client.assistant.chat({ chatId, messages }, abortSignal ? { signal: abortSignal } : {})
    return eventIteratorToUnproxiedDataStream(iterator)
  },
  reconnectToStream: () => Promise.resolve(null),
}
