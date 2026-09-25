import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { z } from 'zod'

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url))
export const MIGRATIONS_SCHEMA = 'meta'
export const MIGRATIONS_TABLE = 'schema_migration'

const TAG_PATTERN = /^\d{14}_[a-z0-9]+(?:_[a-z0-9]+)*$/

const journalSchema = z.object({
  dialect: z.literal('postgresql'),
  entries: z.array(z.object({ idx: z.number().int(), when: z.number().int(), tag: z.string() })),
})

export interface Migration {
  readonly tag: string
  /** drizzle's `created_at` for this migration (the journal's `when`). */
  readonly createdAt: number
  /** sha256 of the file, as drizzle stores it. */
  readonly hash: string
}

export class MigrationFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MigrationFileError'
  }
}

export function loadMigrations(dir: string = MIGRATIONS_DIR): readonly Migration[] {
  const journal = journalSchema.parse(JSON.parse(readFileSync(join(dir, 'meta', '_journal.json'), 'utf8')))
  const files = readMigrationFiles({ migrationsFolder: dir })

  let previous = -Infinity
  return journal.entries.map((entry, index) => {
    const file = files[index]
    if (!TAG_PATTERN.test(entry.tag)) {
      throw new MigrationFileError(`bad migration name "${entry.tag}"; use make db-migration NAME=snake_case`)
    }
    if (entry.when <= previous) {
      throw new MigrationFileError(`migration ${entry.tag} is not newer than the one before it; regenerate it`)
    }
    if (file?.folderMillis !== entry.when) {
      throw new MigrationFileError(`journal and files disagree at ${entry.tag}`)
    }
    previous = entry.when
    return { tag: entry.tag, createdAt: entry.when, hash: file.hash }
  })
}
