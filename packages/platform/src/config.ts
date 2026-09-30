import { readFileSync } from 'node:fs'
import { z } from 'zod'

export class ConfigError extends Error {
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
    this.name = 'ConfigError'
    this.problems = problems
  }
}

export type Env = Readonly<Record<string, string | undefined>>

export interface LoadConfigOptions {
  /** Read from the file named by `<NAME>_FILE`; a plain `<NAME>` env var is rejected. */
  readonly secrets?: readonly string[]
  readonly env?: Env
  readonly readFile?: (path: string) => string
}

const readUtf8 = (path: string): string => readFileSync(path, 'utf8')

export function loadConfig<S extends z.ZodObject>(schema: S, options: LoadConfigOptions = {}): z.output<S> {
  const env = options.env ?? process.env
  const readFile = options.readFile ?? readUtf8
  const problems: string[] = []
  const secretNames = new Set(options.secrets ?? [])
  const input: Record<string, string | undefined> = Object.fromEntries(
    Object.entries(env).filter(([key]) => !secretNames.has(key)),
  )

  for (const name of options.secrets ?? []) {
    const fileVar = `${name}_FILE`
    if (env[name] !== undefined) {
      problems.push(`${name}: must be provided as a file via ${fileVar}, not as a plain env var`)
    }
    const path = env[fileVar]
    if (path === undefined || path === '') {
      problems.push(`${fileVar}: required (path to the secret file)`)
      continue
    }
    let value: string
    try {
      value = readFile(path).replace(/\r?\n$/, '')
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown error'
      problems.push(`${fileVar}: cannot read secret file ${path} (${code})`)
      continue
    }
    if (value === '') {
      problems.push(`${fileVar}: secret file ${path} is empty`)
      continue
    }
    input[name] = value
  }

  const result = schema.safeParse(input)
  if (!result.success) {
    for (const issue of result.error.issues) {
      const key = issue.path.map(String).join('.') || '(root)'
      problems.push(`${key}: ${issue.message}`)
    }
  }

  if (problems.length > 0 || !result.success) {
    throw new ConfigError(problems)
  }
  return result.data
}

export const nodeEnvSchema = z.enum(['development', 'test', 'production'])

export const logLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])

export const databaseUrlSchema = z.string().superRefine((value, ctx) => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    ctx.addIssue({ code: 'custom', message: 'must be a valid URL' })
    return
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    ctx.addIssue({ code: 'custom', message: 'must use the postgres:// scheme' })
  }
  if (url.password !== '') {
    ctx.addIssue({ code: 'custom', message: 'must not contain a password; use DATABASE_PASSWORD_FILE' })
  }
  if (url.username === '' || url.pathname.length <= 1) {
    ctx.addIssue({ code: 'custom', message: 'must include a user and a database name' })
  }
  if (url.search !== '') {
    ctx.addIssue({ code: 'custom', message: 'must not have query parameters' })
  }
})

export interface DatabaseConnectionParams {
  readonly host: string
  readonly port: number
  readonly user: string
  readonly database: string
  readonly password: string
}

// node-postgres lets `connectionString` override an explicit `password`, so pass discrete fields.
export function databaseConnectionParams(databaseUrl: string, password: string): DatabaseConnectionParams {
  const url = new URL(databaseUrl)
  return {
    host: url.hostname,
    port: url.port === '' ? 5432 : Number(url.port),
    user: decodeURIComponent(url.username),
    database: decodeURIComponent(url.pathname.slice(1)),
    password,
  }
}

export const commonEnvShape = {
  NODE_ENV: nodeEnvSchema,
  LOG_LEVEL: logLevelSchema.default('info'),
}

export const databaseEnvShape = {
  DATABASE_URL: databaseUrlSchema,
  DATABASE_PASSWORD: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
}

export const DATABASE_SECRETS = ['DATABASE_PASSWORD'] as const

/** Jev is off unless switched on; then the TypeSafe key must come from a secret file. */
export const jevEnvShape = {
  JEV_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  TYPESAFE_API_KEY: z.string().min(16).optional(),
}

export function jevSecrets(env: Env = process.env): readonly string[] {
  return env.JEV_ENABLED === 'true' ? ['TYPESAFE_API_KEY'] : []
}
