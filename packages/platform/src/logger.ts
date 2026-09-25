import { pino, type Logger } from 'pino'

export type { Logger }

const REDACT_PATHS = [
  'password',
  '*.password',
  'secret',
  '*.secret',
  'token',
  '*.token',
  'authorization',
  '*.authorization',
  'req.headers.authorization',
  'req.headers.cookie',
  'DATABASE_PASSWORD',
  '*.DATABASE_PASSWORD',
]

export interface LoggerOptions {
  readonly service: string
  readonly level: string
}

export function createLogger(options: LoggerOptions): Logger {
  return pino({
    level: options.level,
    base: { service: options.service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  })
}
