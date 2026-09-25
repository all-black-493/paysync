import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MigrationFileError, loadMigrations, type Migration } from './migrations.js'
import { MigrationError, verifyHistory } from './runner.js'

function migrationsDir(entries: ReadonlyArray<{ tag: string; when: number; sql?: string }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'migrations-'))
  mkdirSync(join(dir, 'meta'))
  const journal = {
    version: '7',
    dialect: 'postgresql',
    entries: entries.map((e, idx) => ({ idx, version: '7', when: e.when, tag: e.tag, breakpoints: true })),
  }
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify(journal))
  for (const e of entries) writeFileSync(join(dir, `${e.tag}.sql`), e.sql ?? 'SELECT 1;')
  return dir
}

describe('loadMigrations', () => {
  it('loads the committed migrations in order', () => {
    const migrations = loadMigrations()
    expect(migrations[0]?.tag).toMatch(/^\d{14}_baseline$/)
    expect(migrations.map((m) => m.createdAt)).toEqual([...migrations.map((m) => m.createdAt)].sort((a, b) => a - b))
    for (const m of migrations) expect(m.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('hashes file content, so any edit changes the hash', () => {
    const a = loadMigrations(migrationsDir([{ tag: '20260101000000_a', when: 1, sql: 'SELECT 1;' }]))
    const b = loadMigrations(migrationsDir([{ tag: '20260101000000_a', when: 1, sql: 'SELECT 1; ' }]))
    expect(a[0]?.hash).not.toBe(b[0]?.hash)
  })

  it.each(['0001_add', '20260101000000-add', '20260101000000_Add', '20260101000000_add-things'])(
    'rejects badly named migration %s',
    (tag) => {
      expect(() => loadMigrations(migrationsDir([{ tag, when: 1 }]))).toThrow(MigrationFileError)
    },
  )

  it('rejects entries that are not strictly newer than the previous one', () => {
    const dir = migrationsDir([
      { tag: '20260101000000_a', when: 2 },
      { tag: '20260101000001_b', when: 2 },
    ])
    expect(() => loadMigrations(dir)).toThrow(/not newer/)
  })
})

describe('verifyHistory', () => {
  const m = (tag: string, createdAt: number): Migration => ({ tag, createdAt, hash: `hash-${tag}` })
  const applied = (x: Migration) => ({ hash: x.hash, createdAt: x.createdAt })
  const one = m('a', 1)
  const two = m('b', 2)
  const three = m('c', 3)

  it('accepts a prefix of the history, a full history, and a database that is ahead', () => {
    expect(() => {
      verifyHistory([one, two], [])
    }).not.toThrow()
    expect(() => {
      verifyHistory([one, two], [applied(one)])
    }).not.toThrow()
    expect(() => {
      verifyHistory([one, two], [applied(one), applied(two)])
    }).not.toThrow()
    expect(() => {
      verifyHistory([one], [applied(one), applied(two)])
    }).not.toThrow()
  })

  it('refuses an applied migration whose file was edited', () => {
    expect(() => {
      verifyHistory([one], [{ ...applied(one), hash: 'other' }])
    }).toThrow(/was changed/)
  })

  it('refuses a migration drizzle would silently skip', () => {
    expect(() => {
      verifyHistory([one, two, three], [applied(one), applied(three)])
    }).toThrow(MigrationError)
    expect(() => {
      verifyHistory([one, two, three], [applied(one), applied(three)])
    }).toThrow(/b is older/)
  })

  it('refuses an applied migration that this build no longer has', () => {
    expect(() => {
      verifyHistory([one, three], [applied(one), applied(two)])
    }).toThrow(/does not have/)
  })
})
