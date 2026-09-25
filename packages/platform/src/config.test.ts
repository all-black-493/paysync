import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  ConfigError,
  DATABASE_SECRETS,
  commonEnvShape,
  databaseConnectionParams,
  databaseEnvShape,
  loadConfig,
} from './config.js'

const schema = z.object({ ...commonEnvShape, ...databaseEnvShape })

const files: Record<string, string> = {
  '/run/secrets/db_app_password': 's3cret\n',
  '/run/secrets/empty': '\n',
}
const readFile = (path: string): string => {
  const content = files[path]
  if (content === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
  return content
}

const validEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://paysync_app@db:5432/paysync',
  DATABASE_PASSWORD_FILE: '/run/secrets/db_app_password',
}

function problemsFor(env: Record<string, string>): readonly string[] {
  try {
    loadConfig(schema, { env, secrets: DATABASE_SECRETS, readFile })
  } catch (error) {
    if (error instanceof ConfigError) return error.problems
    throw error
  }
  throw new Error('expected loadConfig to fail')
}

describe('loadConfig', () => {
  it('reads secrets from *_FILE, strips the trailing newline and applies defaults', () => {
    const config = loadConfig(schema, { env: validEnv, secrets: DATABASE_SECRETS, readFile })
    expect(config).toEqual({
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      DATABASE_URL: validEnv.DATABASE_URL,
      DATABASE_PASSWORD: 's3cret',
      DB_POOL_MAX: 10,
    })
  })

  it('lists every problem at once', () => {
    const problems = problemsFor({ LOG_LEVEL: 'loud' })
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^DATABASE_PASSWORD_FILE: required/),
        expect.stringMatching(/^NODE_ENV: /),
        expect.stringMatching(/^LOG_LEVEL: /),
        expect.stringMatching(/^DATABASE_URL: /),
      ]),
    )
  })

  it('rejects secrets passed as plain env vars', () => {
    const problems = problemsFor({ ...validEnv, DATABASE_PASSWORD: 'leaked' })
    expect(problems).toContainEqual(expect.stringMatching(/^DATABASE_PASSWORD: must be provided as a file/))
  })

  it('reports unreadable and empty secret files without leaking contents', () => {
    expect(problemsFor({ ...validEnv, DATABASE_PASSWORD_FILE: '/nope' })).toContainEqual(
      expect.stringMatching(/cannot read secret file \/nope \(ENOENT\)/),
    )
    expect(problemsFor({ ...validEnv, DATABASE_PASSWORD_FILE: '/run/secrets/empty' })).toContainEqual(
      expect.stringMatching(/is empty/),
    )
  })

  it('rejects a DATABASE_URL that embeds a password', () => {
    const problems = problemsFor({ ...validEnv, DATABASE_URL: 'postgres://u:pw@db/paysync' })
    expect(problems).toContainEqual(expect.stringMatching(/^DATABASE_URL: must not contain a password/))
    expect(problems.join('\n')).not.toContain('pw@')
  })

  it('rejects non-postgres URLs and URLs without user or database', () => {
    expect(problemsFor({ ...validEnv, DATABASE_URL: 'mysql://u@db/x' })).toContainEqual(
      expect.stringMatching(/postgres:\/\/ scheme/),
    )
    expect(problemsFor({ ...validEnv, DATABASE_URL: 'postgres://db' })).toContainEqual(
      expect.stringMatching(/user and a database name/),
    )
  })

  it('rejects query parameters so no option is silently ignored', () => {
    expect(problemsFor({ ...validEnv, DATABASE_URL: 'postgres://u@db/x?sslmode=disable' })).toContainEqual(
      expect.stringMatching(/must not have query parameters/),
    )
  })
})

describe('databaseConnectionParams', () => {
  it('splits the URL and carries the password separately', () => {
    expect(databaseConnectionParams('postgres://paysync_app@db:6543/paysync', 'pw')).toEqual({
      host: 'db',
      port: 6543,
      user: 'paysync_app',
      database: 'paysync',
      password: 'pw',
    })
  })

  it('defaults the port to 5432', () => {
    expect(databaseConnectionParams('postgres://u@db/x', 'pw').port).toBe(5432)
  })
})
