import { inspect, parseArgs } from 'node:util'
import { formatTimeline, replay } from '@paysync/audit'
import { createDb, createPool, schema } from '@paysync/db'
import { ConfigError, DATABASE_SECRETS, commonEnvShape, createLogger, databaseEnvShape, loadConfig } from '@paysync/platform'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

const USAGE = `usage: audit-cli replay --org <slug> [--session <id>] [--user <email>] [--since <minutes>]
  prints the audit trail (guard decisions, approvals, changes) oldest first`

const configSchema = z.object({ ...commonEnvShape, ...databaseEnvShape })

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { org: { type: 'string' }, session: { type: 'string' }, user: { type: 'string' }, since: { type: 'string' } },
  })
  if (positionals[0] !== 'replay' || !values.org) {
    process.stderr.write(`${USAGE}\n`)
    process.exit(2)
  }
  const config = loadConfig(configSchema, { secrets: DATABASE_SECRETS })
  const logger = createLogger({ service: 'audit-cli', level: config.LOG_LEVEL })
  const pool = createPool({ url: config.DATABASE_URL, password: config.DATABASE_PASSWORD, max: 2, applicationName: 'audit-cli', logger })
  try {
    const db = createDb(pool)
    const [org] = await db.select({ id: schema.organization.id }).from(schema.organization).where(eq(schema.organization.slug, values.org))
    if (!org) throw new Error(`no organization with slug ${values.org}`)
    const [person] = values.user ? await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, values.user)) : []
    if (values.user && !person) throw new Error(`no user ${values.user}`)
    const entries = await replay(db, org.id, {
      ...(values.session ? { sessionId: values.session } : {}),
      ...(person ? { userId: person.id } : {}),
      ...(values.since ? { since: new Date(Date.now() - Number(values.since) * 60_000) } : {}),
    })
    process.stdout.write(`${entries.length === 0 ? '(no events)' : formatTimeline(entries)}\n`)
  } finally {
    await pool.end()
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`audit-cli failed: ${error instanceof ConfigError ? error.message : inspect(error)}\n`)
  process.exit(1)
})
