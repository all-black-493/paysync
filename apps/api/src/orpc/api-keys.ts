import { keyPermissionsFor, scopeOf } from '@paysync/auth'
import { schema } from '@paysync/db'
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { API_KEY_CONFIG } from '../auth.js'
import { authed } from './base.js'
import { iso } from './mappers.js'
import { mutate, type Preview } from './mutate.js'

const { apikey } = schema
type ApiKeyRow = typeof apikey.$inferSelect

const DAY_SECONDS = 24 * 60 * 60

function toApiKey(row: ApiKeyRow) {
  return {
    id: row.id,
    name: row.name ?? '',
    scope: scopeOf(parsePermissions(row.permissions)),
    start: row.start,
    enabled: row.enabled ?? false,
    createdAt: iso(row.createdAt),
    expiresAt: row.expiresAt ? iso(row.expiresAt) : null,
    lastUsedAt: row.lastRequest ? iso(row.lastRequest) : null,
  }
}

function parsePermissions(value: string | null): unknown {
  if (value === null) return null
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

const ApiKeyShape = z.object({
  id: z.string(),
  name: z.string(),
  scope: z.enum(['read', 'write']).nullable(),
  start: z.string().nullable(),
  enabled: z.boolean(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
})
type ApiKeyShape = z.infer<typeof ApiKeyShape>

const orgKeys = (orgId: string) => and(eq(apikey.referenceId, orgId), eq(apikey.configId, API_KEY_CONFIG))

const list = authed.apiKeys.list.handler(async ({ context }) => {
  const rows = await context.db.select().from(apikey).where(orgKeys(context.caller.orgId)).orderBy(desc(apikey.createdAt))
  return { items: rows.map(toApiKey) }
})

const create = authed.apiKeys.create.handler(async ({ context, input }) =>
  mutate({
    db: context.db,
    caller: context.caller,
    surface: context.surface,
    action: 'apiKeys.create',
    input,
    output: z.object({
      dryRun: z.boolean(),
      changed: z.boolean(),
      result: z.object({ apiKey: ApiKeyShape, key: z.string().nullable() }),
    }),
    run: async () => {
      const expiresIn = input.expiresInDays * DAY_SECONDS
      if (input.dryRun) {
        const now = new Date()
        return {
          changed: true,
          result: {
            key: null,
            apiKey: {
              id: 'dry-run',
              name: input.name,
              scope: input.scope,
              start: null,
              enabled: true,
              createdAt: iso(now),
              expiresAt: iso(new Date(now.getTime() + expiresIn * 1000)),
              lastUsedAt: null,
            },
          },
        }
      }
      const created = await context.auth.api.createApiKey({
        body: {
          configId: API_KEY_CONFIG,
          organizationId: context.caller.orgId,
          userId: context.caller.actorId,
          name: input.name,
          expiresIn,
          permissions: keyPermissionsFor(input.scope),
        },
      })
      const [row] = await context.db.select().from(apikey).where(eq(apikey.id, created.id))
      if (!row) throw new Error('created API key not found')
      return { changed: true, result: { apiKey: toApiKey(row), key: created.key } }
    },
    stored: (preview: Preview<{ apiKey: ApiKeyShape; key: string | null }>) => ({
      ...preview,
      result: { ...preview.result, key: null },
    }),
  }),
)

const revoke = authed.apiKeys.revoke.handler(async ({ context, input, errors }) =>
  mutate({
    db: context.db,
    caller: context.caller,
    surface: context.surface,
    action: 'apiKeys.revoke',
    input,
    output: z.object({ dryRun: z.boolean(), changed: z.boolean(), result: ApiKeyShape }),
    run: async (tx) => {
      const [row] = await tx
        .select()
        .from(apikey)
        .where(and(eq(apikey.id, input.id), orgKeys(context.caller.orgId)))
        .for('update')
      if (!row) throw errors.NOT_FOUND()
      if (!row.enabled) return { changed: false, result: toApiKey(row) }
      const [updated] = await tx
        .update(apikey)
        .set({ enabled: false, updatedAt: new Date() })
        .where(eq(apikey.id, row.id))
        .returning()
      if (!updated) throw new Error('update returned no row')
      return { changed: true, result: toApiKey(updated) }
    },
  }),
)

export const apiKeyProcedures = { list, create, revoke }
