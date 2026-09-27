import type { IncomingMessage, ServerResponse } from 'node:http'
import { safeEqual } from '@paysync/platform'
import { ingestC2B, ingestStkCallback, storeMalformed, type IngestDeps } from './ingest.js'

const MAX_BODY_BYTES = 64 * 1024
const ROUTE = /^\/hooks\/(c2b\/validation|c2b\/confirmation|stk)\/([^/]+)$/

export interface HookOptions extends IngestDeps {
  readonly callbackSecret: string
  /** Empty disables the source-IP check (sandbox). Ranges must come from Safaricom. */
  readonly allowedIps: readonly string[]
}

class BodyTooLarge extends Error {}

function send(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge()
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Caddy sets X-Forwarded-For and drops client-supplied values. */
function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for']
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim()
  return first ?? req.socket.remoteAddress ?? ''
}

// Daraja documents only the validation response; the same shape acknowledges
// confirmations, and STK callbacks get the numeric form they use themselves.
const ACCEPTED_C2B = { ResultCode: '0', ResultDesc: 'Accepted' }
const ACCEPTED_STK = { ResultCode: 0, ResultDesc: 'Accepted' }

/**
 * Daraja callback routes: plain HTTP, never oRPC procedures or agent tools.
 * A delivery is acknowledged only once stored; if storage fails the response
 * is 500 so Daraja delivers it again.
 */
export function createHookHandler(options: HookOptions) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = (req.url ?? '').split('?', 1)[0] ?? ''
    if (!path.startsWith('/hooks/')) return false
    const match = ROUTE.exec(path)
    const kind = match?.[1]
    const secret = match?.[2]
    if (req.method !== 'POST' || !kind || !secret || !safeEqual(secret, options.callbackSecret)) {
      send(res, 404, { status: 'not_found' })
      return true
    }
    if (options.allowedIps.length > 0 && !options.allowedIps.includes(clientIp(req))) {
      options.logger.warn({ ip: clientIp(req) }, 'callback from an address outside the allowlist')
      send(res, 403, { status: 'forbidden' })
      return true
    }

    const source = kind === 'stk' ? 'stk_callback' : kind === 'c2b/validation' ? 'c2b_validation' : 'c2b_confirmation'
    const accepted = source === 'stk_callback' ? ACCEPTED_STK : ACCEPTED_C2B
    try {
      const text = await readBody(req)
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        await storeMalformed(options, source, text)
        send(res, 200, accepted)
        return true
      }
      const result =
        source === 'stk_callback' ? await ingestStkCallback(options, body) : await ingestC2B(options, source, body)
      options.logger.info({ source, ...result }, 'callback stored')
      send(res, 200, accepted)
    } catch (error) {
      if (error instanceof BodyTooLarge) {
        send(res, 413, { status: 'too_large' })
        return true
      }
      options.logger.error({ err: error, source }, 'callback could not be stored; not acknowledged')
      send(res, 500, { ResultCode: '1', ResultDesc: 'Not stored; retry' })
    }
    return true
  }
}
