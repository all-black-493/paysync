import { z } from 'zod'
import { authClient } from './auth-client'

/** What each scope lets a connected app do, in the words the consent screen uses. */
export const SCOPE_TEXT: Record<string, string> = {
  'paysync:read': 'Read payments, expected payments, exceptions and matches.',
  'paysync:write': 'Match payments, add notes and file requests. Voids, write-offs and reversals still wait for an approver.',
  openid: 'Know who you are.',
  profile: 'See your name.',
  offline_access: 'Stay connected until you disconnect it.',
}

const PublicClient = z.object({ client_name: z.string().optional(), client_id: z.string().optional() })

export interface AppIdentity {
  readonly name: string
  /** Where the app is published: the host of its client id URL (CIMD), or the id itself. */
  readonly source: string
}

export function sourceOf(clientId: string): string {
  try {
    return new URL(clientId).host
  } catch {
    return clientId
  }
}

export async function appIdentity(clientId: string): Promise<AppIdentity> {
  const { data } = await authClient.$fetch('/oauth2/public-client', { method: 'GET', query: { client_id: clientId } })
  const parsed = PublicClient.safeParse(data)
  return { name: parsed.success && parsed.data.client_name ? parsed.data.client_name : 'Unnamed app', source: sourceOf(clientId) }
}

const Consent = z.object({ id: z.string(), clientId: z.string(), scopes: z.union([z.array(z.string()), z.string()]), createdAt: z.coerce.date() })
export type AppConsent = z.infer<typeof Consent> & { readonly scopeList: readonly string[] }

export async function listConsents(): Promise<AppConsent[]> {
  const { data, error } = await authClient.$fetch('/oauth2/get-consents', { method: 'GET' })
  if (error) throw new Error('Could not load connected apps.')
  return z
    .array(Consent)
    .parse(data)
    .map((c) => ({ ...c, scopeList: Array.isArray(c.scopes) ? c.scopes : c.scopes.split(' ').filter(Boolean) }))
}

export async function revokeConsent(id: string): Promise<void> {
  const { error } = await authClient.$fetch('/oauth2/delete-consent', { method: 'POST', body: { id } })
  if (error) throw new Error('Could not disconnect the app.')
}
