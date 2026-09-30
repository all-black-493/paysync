'use client'

import { useChat } from '@ai-sdk/react'
import { ORPCError } from '@orpc/client'
import { isToolUIPart, lastAssistantMessageIsCompleteWithApprovalResponses } from 'ai'
import { useEffect, useRef, useState } from 'react'
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from '@/components/ai-elements/conversation'
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import { PromptInput, PromptInputBody, PromptInputFooter, PromptInputSubmit, PromptInputTextarea } from '@/components/ai-elements/prompt-input'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { Suggestion, Suggestions } from '@/components/ai-elements/suggestion'
import { assistantTransport } from '../../lib/assistant-transport'
import { useRefreshRecords } from '../../lib/refresh'
import { ToolPart } from './tool-part'

const STARTERS = ['What needs attention today?', 'Match the payments that clearly fit', 'What is waiting for approval?']

const newChatId = () => `c${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`

function errorText(error: Error): string {
  const code = error instanceof ORPCError ? String(error.code) : ''
  if (code === 'ASSISTANT_OFF') return 'The assistant is not switched on here.'
  if (code === 'RATE_LIMITED') return 'You have used the assistant a lot this hour. Try again later.'
  return 'Something went wrong. Try again.'
}

/** The in-app assistant (AI Elements) in the side panel: it works as you, and anything risky still waits for an approver. */
export function AssistantDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const refresh = useRefreshRecords()
  const [chatId, setChatId] = useState(newChatId)
  const { messages, sendMessage, status, stop, error, addToolApprovalResponse, clearError } = useChat({
    id: chatId,
    transport: assistantTransport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onFinish: () => {
      refresh()
    },
  })
  const busy = status === 'submitted' || status === 'streaming'

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  function send(text: string) {
    if (text.trim() === '' || busy) return
    clearError()
    void sendMessage({ text: text.trim() })
  }

  return (
    <dialog ref={ref} className="drawer" aria-labelledby="assistant-title" onClose={onClose} onClick={(e) => { if (e.target === e.currentTarget) ref.current?.close() }}>
      <div className="drawer-inner">
        <header className="drawer-head">
          <h2 id="assistant-title" className="label">
            Assistant
          </h2>
          <div className="actions">
            <button type="button" className="btn" disabled={busy || messages.length === 0} onClick={() => { setChatId(newChatId()) }}>
              New chat
            </button>
            <button type="button" className="btn btn-icon" aria-label="Close assistant" onClick={() => ref.current?.close()}>
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
                <path d="M2 2l10 10M12 2 2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
              </svg>
            </button>
          </div>
        </header>
        <div className="assistant-body">
          <Conversation className="min-h-0">
            <ConversationContent>
              {messages.length === 0 ? (
                <ConversationEmptyState
                  title="Ask about your payments"
                  description="It works as you. Voids, write-offs and reversals still wait for an approver."
                />
              ) : null}
              {messages.map((m) => (
                <Message key={m.id} from={m.role}>
                  <MessageContent>
                    {m.parts.map((part, i) => {
                      const key = `${m.id}-${String(i)}`
                      if (part.type === 'text') return <MessageResponse key={key}>{part.text}</MessageResponse>
                      if (isToolUIPart(part)) {
                        return <ToolPart key={key} part={part} onDecide={(id, approved) => void addToolApprovalResponse({ id, approved })} />
                      }
                      return null
                    })}
                  </MessageContent>
                </Message>
              ))}
              {status === 'submitted' ? <Shimmer>Thinking…</Shimmer> : null}
              {error ? (
                <p className="error" role="alert">
                  {errorText(error)}
                </p>
              ) : null}
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>
          <div className="assistant-compose">
            {messages.length === 0 ? (
              <Suggestions>
                {STARTERS.map((s) => (
                  <Suggestion key={s} suggestion={s} onClick={send} />
                ))}
              </Suggestions>
            ) : null}
            <PromptInput onSubmit={({ text }) => { send(text) }}>
              <PromptInputBody>
                <PromptInputTextarea placeholder="Ask the assistant" maxLength={2000} />
              </PromptInputBody>
              <PromptInputFooter className="justify-end">
                <PromptInputSubmit status={status} onClick={busy ? (e) => { e.preventDefault(); void stop() } : undefined} />
              </PromptInputFooter>
            </PromptInput>
          </div>
        </div>
      </div>
    </dialog>
  )
}
