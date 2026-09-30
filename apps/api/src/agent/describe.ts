import { z } from 'zod'

const OpenApiMeta = z.object({ '~openapi': z.object({ summary: z.string().optional(), description: z.string().optional() }).optional() })

/** A tool description from the contract's route text, which is written for an agent reader (§8.2). */
export function descriptionOf(meta: Readonly<Record<PropertyKey, unknown>>): string {
  const parsed = OpenApiMeta.safeParse(meta)
  const route = parsed.success ? parsed.data['~openapi'] : undefined
  return [route?.summary, route?.description].filter(Boolean).join('. ')
}
