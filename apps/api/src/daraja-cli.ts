import { createHash } from 'node:crypto'
import { parseArgs, inspect } from 'node:util'
import { DarajaClient, buildScenario, loadFixtures, replay, StkCallback } from '@paysync/daraja'
import { createDarajaTokenStore, createDb, createPool, schema, withOrg, type Db } from '@paysync/db'
import {
  ConfigError,
  DATABASE_SECRETS,
  commonEnvShape,
  createLogger,
  createSealer,
  databaseEnvShape,
  loadConfig,
  type Logger,
} from '@paysync/platform'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'

const configSchema = z.object({
  ...commonEnvShape,
  ...databaseEnvShape,
  DARAJA_CONSUMER_KEY: z.string().min(8),
  DARAJA_CONSUMER_SECRET: z.string().min(8),
  DARAJA_PASSKEY: z.string().min(8),
  CALLBACK_PATH_SECRET: z.string().min(32),
  DATA_ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/),
  DARAJA_SHORTCODE: z.string().regex(/^\d{5,7}$/).default('174379'),
  DARAJA_C2B_SHORTCODE: z.string().regex(/^\d{5,7}$/).default('600984'),
  CALLBACK_BASE_URL: z.preprocess((v) => (v === '' ? undefined : v), z.url().optional()),
  API_INTERNAL_URL: z.url().default('http://api:3000'),
})
type Config = z.output<typeof configSchema>

const USAGE = `usage: daraja-cli <command> [options]
  replay [--copies 3] [--seed 1]                 replay every callback fixture against the running api
  register-c2b                                   register C2B URLs under CALLBACK_BASE_URL (sandbox)
  simulate-c2b --amount 10 --ref TEXT [--msisdn] ask the sandbox to send a C2B payment
  stk-push --amount 1 --phone 07XXXXXXXX --ref R send an M-Pesa Express prompt (sandbox)
  stk-query --checkout ws_CO_...                 check and record the status of a push`

interface Ctx {
  readonly config: Config
  readonly db: Db
  readonly logger: Logger
  readonly client: DarajaClient
}

function callbackUrl(config: Config, kind: 'c2b/confirmation' | 'c2b/validation' | 'stk'): string {
  if (!config.CALLBACK_BASE_URL) throw new Error('set CALLBACK_BASE_URL to the public tunnel URL first (make tunnel-url)')
  return `${config.CALLBACK_BASE_URL.replace(/\/$/, '')}/hooks/${kind}/${config.CALLBACK_PATH_SECRET}`
}

const Route = z.object({ shortcode_id: z.string(), org_id: z.string() })

async function routeShortcode(db: Db, code: string) {
  const { rows } = await db.execute(sql`SELECT * FROM ingest.route_shortcode('sandbox', ${code})`)
  const row = Route.safeParse(rows[0])
  if (!row.success) throw new Error(`no organization owns sandbox shortcode ${code}; run make seed`)
  return row.data
}

async function ensureFixtureStkRequests(ctx: Ctx) {
  const target = await routeShortcode(ctx.db, ctx.config.DARAJA_SHORTCODE)
  const callbacks = [...loadFixtures().values()].filter((f) => f.meta.kind === 'stk_callback')
  await withOrg(ctx.db, target.org_id, async (tx) => {
    for (const f of callbacks) {
      const cb = StkCallback.parse(f.payload).Body.stkCallback
      const amount = cb.CallbackMetadata?.Item.find((i) => i.Name === 'Amount')?.Value ?? 1
      await tx
        .insert(schema.stkRequest)
        .values({
          orgId: target.org_id,
          shortcodeId: target.shortcode_id,
          checkoutRequestId: cb.CheckoutRequestID,
          merchantRequestId: cb.MerchantRequestID,
          accountReference: 'FIXTURE',
          amount: BigInt(Math.round(Number(amount) * 100)),
          status: 'pending',
        })
        .onConflictDoNothing({ target: schema.stkRequest.checkoutRequestId })
    }
  })
}

async function replayCommand(ctx: Ctx, args: { copies: number; seed: number }) {
  await ensureFixtureStkRequests(ctx)
  const deliveries = buildScenario({ c2bShortcode: ctx.config.DARAJA_C2B_SHORTCODE, copies: args.copies, seed: args.seed })
  const result = await replay(ctx.config.API_INTERNAL_URL, ctx.config.CALLBACK_PATH_SECRET, deliveries)
  const receipts = new Map<string, number>()
  for (const code of [ctx.config.DARAJA_C2B_SHORTCODE, ctx.config.DARAJA_SHORTCODE]) {
    const target = await routeShortcode(ctx.db, code)
    const rows = await withOrg(ctx.db, target.org_id, (tx) =>
      tx
        .select({ receipt: schema.mpesaTransaction.receiptNumber, n: sql<number>`count(*)::int` })
        .from(schema.mpesaTransaction)
        .where(eq(schema.mpesaTransaction.shortcodeId, target.shortcode_id))
        .groupBy(schema.mpesaTransaction.receiptNumber),
    )
    for (const r of rows) receipts.set(r.receipt, (receipts.get(r.receipt) ?? 0) + r.n)
  }
  const duplicates = [...receipts].filter(([, n]) => n !== 1)
  ctx.logger.info(
    { sent: result.sent, acknowledged: result.acknowledged, failures: result.failures, transactionsPerReceipt: Object.fromEntries(receipts) },
    duplicates.length === 0 && result.failures.length === 0 ? 'replay ok: one transaction per receipt' : 'replay FAILED',
  )
  if (duplicates.length > 0 || result.failures.length > 0) process.exitCode = 1
}

async function stkPush(ctx: Ctx, args: { amount: string; phone: string; ref: string }) {
  const target = await routeShortcode(ctx.db, ctx.config.DARAJA_SHORTCODE)
  const amountMinor = BigInt(args.amount) * 100n
  const pii = createSealer(ctx.config.DATA_ENCRYPTION_KEY, 'pii')
  // Record the intent before calling Daraja, so the callback always has a row to land on.
  const [request] = await withOrg(ctx.db, target.org_id, (tx) =>
    tx
      .insert(schema.stkRequest)
      .values({
        orgId: target.org_id,
        shortcodeId: target.shortcode_id,
        accountReference: args.ref,
        amount: amountMinor,
        phoneCiphertext: pii.seal(args.phone),
        createdBy: 'daraja-cli',
      })
      .returning(),
  )
  if (!request) throw new Error('could not record the STK request')
  try {
    const res = await ctx.client.stkPush({
      shortcode: ctx.config.DARAJA_SHORTCODE,
      transactionType: 'CustomerPayBillOnline',
      amountMinor,
      phone: args.phone,
      accountReference: args.ref,
      description: 'Paysync test',
      callbackUrl: callbackUrl(ctx.config, 'stk'),
    })
    await withOrg(ctx.db, target.org_id, (tx) =>
      tx
        .update(schema.stkRequest)
        .set({ checkoutRequestId: res.CheckoutRequestID, merchantRequestId: res.MerchantRequestID, status: 'pending', version: request.version + 1 })
        .where(eq(schema.stkRequest.id, request.id)),
    )
    ctx.logger.info({ checkoutRequestId: res.CheckoutRequestID, response: res.ResponseDescription }, 'STK push accepted')
  } catch (error) {
    await withOrg(ctx.db, target.org_id, (tx) =>
      tx
        .update(schema.stkRequest)
        .set({ status: 'failed', resultDesc: error instanceof Error ? error.message : 'push failed', version: request.version + 1 })
        .where(eq(schema.stkRequest.id, request.id)),
    )
    throw error
  }
}

async function stkQuery(ctx: Ctx, checkout: string) {
  const result = await ctx.client.stkQuery(ctx.config.DARAJA_SHORTCODE, checkout)
  ctx.logger.info({ checkout, ...result }, 'STK query')
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      copies: { type: 'string', default: '3' },
      seed: { type: 'string', default: String(Date.now() % 100_000) },
      amount: { type: 'string' },
      phone: { type: 'string' },
      msisdn: { type: 'string', default: '254708374149' },
      ref: { type: 'string' },
      checkout: { type: 'string' },
    },
  })
  const command = positionals[0]
  if (!command) {
    process.stderr.write(`${USAGE}\n`)
    process.exit(2)
  }
  const config = loadConfig(configSchema, {
    secrets: [...DATABASE_SECRETS, 'DARAJA_CONSUMER_KEY', 'DARAJA_CONSUMER_SECRET', 'DARAJA_PASSKEY', 'CALLBACK_PATH_SECRET', 'DATA_ENCRYPTION_KEY'],
  })
  if (config.NODE_ENV === 'production') throw new Error('the Daraja CLI is for the sandbox only')
  const logger = createLogger({ service: 'daraja-cli', level: config.LOG_LEVEL })
  const pool = createPool({ url: config.DATABASE_URL, password: config.DATABASE_PASSWORD, max: 2, applicationName: 'daraja-cli', logger })
  const db = createDb(pool)
  const client = new DarajaClient({
    environment: 'sandbox',
    credentialId: `sandbox:${createHash('sha256').update(config.DARAJA_CONSUMER_KEY).digest('hex').slice(0, 12)}`,
    credentials: { consumerKey: config.DARAJA_CONSUMER_KEY, consumerSecret: config.DARAJA_CONSUMER_SECRET, passkey: config.DARAJA_PASSKEY },
    tokenStore: createDarajaTokenStore(pool, createSealer(config.DATA_ENCRYPTION_KEY, 'daraja-token')),
    logger,
  })
  const ctx: Ctx = { config, db, logger, client }
  const require = (value: string | undefined, name: string) => {
    if (!value) throw new Error(`--${name} is required\n${USAGE}`)
    return value
  }
  try {
    switch (command) {
      case 'replay':
        await replayCommand(ctx, { copies: Number(values.copies), seed: Number(values.seed) })
        break
      case 'register-c2b': {
        const res = await client.registerC2BUrls({
          shortcode: config.DARAJA_C2B_SHORTCODE,
          confirmationUrl: callbackUrl(config, 'c2b/confirmation'),
          validationUrl: callbackUrl(config, 'c2b/validation'),
          responseType: 'Completed',
        })
        logger.info({ response: res }, 'C2B URLs registered')
        break
      }
      case 'simulate-c2b': {
        const res = await client.simulateC2B({
          shortcode: config.DARAJA_C2B_SHORTCODE,
          commandId: 'CustomerPayBillOnline',
          amountMinor: BigInt(require(values.amount, 'amount')) * 100n,
          msisdn: values.msisdn,
          billRefNumber: require(values.ref, 'ref'),
        })
        logger.info({ response: res }, 'C2B simulation accepted')
        break
      }
      case 'stk-push':
        await stkPush(ctx, { amount: require(values.amount, 'amount'), phone: require(values.phone, 'phone'), ref: require(values.ref, 'ref') })
        break
      case 'stk-query':
        await stkQuery(ctx, require(values.checkout, 'checkout'))
        break
      default:
        process.stderr.write(`${USAGE}\n`)
        process.exitCode = 2
    }
  } finally {
    await pool.end()
  }
}

main().catch((error: unknown) => {
  const message = error instanceof ConfigError ? error.message : inspect(error)
  process.stderr.write(`daraja-cli failed: ${message}\n`)
  process.exit(1)
})
