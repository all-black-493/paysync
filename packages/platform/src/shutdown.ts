import type { Server } from 'node:http'
import type { Logger } from './logger.js'

export interface ShutdownStep {
  readonly name: string
  readonly run: () => Promise<void>
}

export interface ShutdownOptions {
  readonly logger: Logger
  readonly timeoutMs: number
  readonly steps: readonly ShutdownStep[]
  readonly exit?: (code: number) => void
}

export function installGracefulShutdown(options: ShutdownOptions): (signal: string) => Promise<void> {
  const exit = options.exit ?? ((code: number) => process.exit(code))
  let started = false

  const shutdown = async (signal: string): Promise<void> => {
    if (started) return
    started = true
    options.logger.info({ signal }, 'shutdown started')
    const deadline = setTimeout(() => {
      options.logger.error({ timeoutMs: options.timeoutMs }, 'shutdown timed out, forcing exit')
      exit(1)
    }, options.timeoutMs)
    deadline.unref()

    let code = 0
    for (const step of options.steps) {
      try {
        await step.run()
        options.logger.info({ step: step.name }, 'shutdown step done')
      } catch (error) {
        code = 1
        options.logger.error({ err: error, step: step.name }, 'shutdown step failed')
      }
    }
    clearTimeout(deadline)
    options.logger.info({ code }, 'shutdown complete')
    exit(code)
  }

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => void shutdown(signal))
  }
  return shutdown
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
    server.closeIdleConnections()
  })
}

export function listen(server: Server, port: number, host = '0.0.0.0'): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
}
