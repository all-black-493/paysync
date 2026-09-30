'use client'

import { useChat } from '@ai-sdk/react'
import { ORPCError } from '@orpc/client'
import { isToolUIPart, lastAssistantMessageIsCompleteWithApprovalResponses } from 'ai'
import { useEffect, useRef, useState, type SubmitEvent } from 'react'
import { assistantTransport } from '../../lib/assistant-transport'
import { useRefreshRecords } from '../../lib/refresh'
import { ToolStep } from './tool-step'

const newChatId = () => `c${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`

function errorText(error: Error): string {
  const code = error instanceof ORPCError ? String(error.code) : ''
  if (code === 'ASSISTANT_OFF') return 'The assistant is not switched on here.'
  if (code === 'RATE_LIMITED') return 'You have used the assistant a lot this hour. Try again later.'
  return 'Something went wrong. Try again.'
}

/** The in-app assistant in a side panel: it works as you, and anything risky still waits for an approver. */
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

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const text = new FormData(form).get('message')
    if (typeof text !== 'string' || text.trim() === '' || busy) return
    clearError()
    void sendMessage({ text: text.trim() })
    form.reset()
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
          <div className="assistant-log" aria-live="polite">
            {messages.length === 0 ? (
              <p className="quiet">Ask about today’s exceptions, or to match what clearly fits. It works as you, and voids, write-offs and reversals still wait for an approver.</p>
            ) : null}
            {messages.map((m) => (
              <div key={m.id} className={m.role === 'user' ? 'assistant-msg user' : 'assistant-msg'}>
                {m.parts.map((part, i) => {
                  const key = `${m.id}-${String(i)}`
                  if (part.type === 'text') return <p key={key}>{part.text}</p>
                  if (isToolUIPart(part)) {
                    return <ToolStep key={key} part={part} onDecide={(id, approved) => void addToolApprovalResponse({ id, approved })} />
                  }
                  return null
                })}
              </div>
            ))}
            {status === 'submitted' ? <p className="quiet">Thinking…</p> : null}
            {error ? (
              <p className="error" role="alert">
                {errorText(error)}
              </p>
            ) : null}
          </div>
          <form className="assistant-input" onSubmit={onSubmit}>
            <label className="visually-hidden" htmlFor="assistant-message">
              Message
            </label>
            <textarea id="assistant-message" name="message" rows={2} maxLength={2000} placeholder="Match the payments that clearly fit" />
            {busy ? (
              <button type="button" className="btn" onClick={() => void stop()}>
                Stop
              </button>
            ) : (
              <button type="submit" className="btn btn-primary">
                Send
              </button>
            )}
          </form>
        </div>
      </div>
    </dialog>
  )
}
