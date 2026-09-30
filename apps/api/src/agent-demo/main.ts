import { inspect } from 'node:util'
import { createDb, createPool } from '@paysync/db'
import { fakeJev, jevFromConfig, type Jev } from '@paysync/decisions'
import { ConfigError, DATABASE_SECRETS, commonEnvShape, createLogger, databaseEnvShape, jevEnvShape, jevSecrets, loadConfig } from '@paysync/platform'
import { z } from 'zod'
import { createAuth } from '../auth.js'
import { DEMO_REQUEST, runAgentDemo } from './run.js'

const configSchema = z.object({
  ...commonEnvShape,
  ...databaseEnvShape,
  ...jevEnvShape,
  PUBLIC_URL: z.url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  SEED_PASSWORD: z.string().min(12).default('paysync-dev-password'),
})

/** Without TypeSafe credits, Jev is scripted too: satisfied with every action, so the static guard's gates show on their own. */
const SCRIPTED_JEV: Jev = fakeJev({
  answer: (name) => (name === 'intent' ? { choice: 'matches_request', confidence: 0.95 } : name === 'injection' ? 0.01 : 0.05),
})

async function main(): Promise<void> {
  const config = loadConfig(configSchema, { secrets: [...DATABASE_SECRETS, 'BETTER_AUTH_SECRET', ...jevSecrets()] })
  if (config.NODE_ENV === 'production') throw new Error('the agent demo refuses to run with NODE_ENV=production')
  const logger = createLogger({ service: 'agent-demo', level: 'warn' })
  const pool = createPool({ url: config.DATABASE_URL, password: config.DATABASE_PASSWORD, max: 4, applicationName: 'paysync-agent-demo', logger })
  try {
    const db = createDb(pool)
    const auth = createAuth({ db, secret: config.BETTER_AUTH_SECRET, baseURL: config.PUBLIC_URL })
    const jev = config.JEV_ENABLED ? jevFromConfig(config) : SCRIPTED_JEV
    const report = await runAgentDemo({ auth, db, logger, jev }, config.SEED_PASSWORD)
    const out = [
      `Agent demo (scripted model${config.JEV_ENABLED ? ', live Jev' : ', scripted Jev'}) for ${report.org.person.name} <${report.org.person.email}>`,
      `Organization ${report.org.slug}; agent session ${report.sessionId}`,
      `Request: "${DEMO_REQUEST}"`,
      '',
      'Tool calls:',
      ...report.transcript.map((t) => `  ${t}`),
      '',
      'Agent:',
      ...report.answer.split('\n').map((l) => `  ${l}`),
      '',
      `Open exceptions: ${String(report.openBefore)} before, ${String(report.openAfter)} after.`,
      'Waiting for a person in the web app:',
      ...report.pending.map((p) => `  ${p.procedure} (${String(p.approvalsRequired)} approver${p.approvalsRequired === 2 ? 's' : ''}): ${p.summary}`),
      `  Approvers: ${report.org.approvers.join(', ')} (password: the seed password; set up two-factor under Security first)`,
      '',
      `Replay of session ${report.sessionId}:`,
      report.timeline,
    ]
    process.stdout.write(`${out.join('\n')}\n`)
  } finally {
    await pool.end()
  }
}

main().catch((error: unknown) => {
  const message = error instanceof ConfigError ? error.message : inspect(error)
  process.stderr.write(`agent demo failed: ${message}\n`)
  process.exit(1)
})
