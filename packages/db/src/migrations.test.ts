import { describe, expect, it } from 'vitest'
import { MigrationFileError, NO_TRANSACTION_MARKER, loadMigrations, parseMigration } from './migrations.js'

describe('parseMigration', () => {
  it('accepts YYYYMMDDHHMM_description.sql and hashes the content', () => {
    const m = parseMigration('202609250000_add_things.sql', 'SELECT 1;')
    expect(m.id).toBe('202609250000_add_things')
    expect(m.checksum).toMatch(/^[0-9a-f]{64}$/)
    expect(m.transactional).toBe(true)
  })

  it.each(['20260925_add.sql', '202609250000-add.sql', '202609250000_Add.sql', '202609250000_add.SQL', 'notes.md'])(
    'rejects bad file name %s',
    (name) => {
      expect(() => parseMigration(name, 'SELECT 1;')).toThrow(MigrationFileError)
    },
  )

  it('rejects empty files', () => {
    expect(() => parseMigration('202609250000_empty.sql', ' \n')).toThrow(/empty/)
  })

  it('detects the no-transaction marker on the first line only', () => {
    const sql = `${NO_TRANSACTION_MARKER}\nCREATE INDEX CONCURRENTLY i ON t (c);`
    expect(parseMigration('202609250001_idx.sql', sql).transactional).toBe(false)
    expect(parseMigration('202609250001_idx.sql', `SELECT 1;\n${NO_TRANSACTION_MARKER}`).transactional).toBe(true)
  })

  it('gives a different checksum for any edit', () => {
    const a = parseMigration('202609250000_a.sql', 'SELECT 1;')
    const b = parseMigration('202609250000_a.sql', 'SELECT 1; ')
    expect(a.checksum).not.toBe(b.checksum)
  })
})

describe('loadMigrations', () => {
  it('loads the committed migrations in id order', () => {
    const ids = loadMigrations().map((m) => m.id)
    expect(ids.length).toBeGreaterThan(0)
    expect(ids).toEqual([...ids].sort())
    expect(ids[0]).toBe('202609250000_baseline')
  })
})
