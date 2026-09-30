export interface Message {
  readonly tone: 'info' | 'error'
  readonly text: string
}

/** Announced to screen readers: errors interrupt, everything else waits its turn. */
export function FormMessage({ message }: { message: Message | null }) {
  return (
    <p className="form-message" data-tone={message?.tone} role={message?.tone === 'error' ? 'alert' : 'status'}>
      {message?.text}
    </p>
  )
}
