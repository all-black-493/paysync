import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FILE_PATTERN = /^(\d{12})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/

/** First-line marker for single-statement migrations that cannot run in a transaction. */
export const NO_TRANSACTION_MARKER = '-- paysync:no-transaction'

export interface Migration {
  readonly id: string
  readonly sql: string
  readonly checksum: string
  readonly transactional: boolean
}

export class MigrationFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MigrationFileError'
  }
}

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url))

export function parseMigration(fileName: string, sql: string): Migration {
  const match = FILE_PATTERN.exec(fileName)
  if (!match) {
    throw new MigrationFileError(`bad migration file name "${fileName}"; expected YYYYMMDDHHMM_description.sql`)
  }
  if (sql.trim() === '') throw new MigrationFileError(`migration ${fileName} is empty`)
  return {
    id: fileName.slice(0, -'.sql'.length),
    sql,
    checksum: createHash('sha256').update(sql).digest('hex'),
    transactional: !sql.startsWith(NO_TRANSACTION_MARKER),
  }
}

export function loadMigrations(dir: string = MIGRATIONS_DIR): readonly Migration[] {
  const files = readdirSync(dir).sort()
  return files.map((file) => parseMigration(file, readFileSync(join(dir, file), 'utf8')))
}
