import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DecryptionError, createSealer, safeEqual } from './crypto.js'

const key = randomBytes(32).toString('hex')

describe('sealer', () => {
  it('round-trips, uses a fresh IV each time, and binds the purpose', () => {
    const pii = createSealer(key, 'pii')
    const a = pii.seal('2547 ***** 126')
    const b = pii.seal('2547 ***** 126')
    expect(a.equals(b)).toBe(false)
    expect(pii.open(a)).toBe('2547 ***** 126')
    expect(() => createSealer(key, 'tokens').open(a)).toThrow(DecryptionError)
  })

  it('detects tampering and wrong keys', () => {
    const pii = createSealer(key, 'pii')
    const sealed = pii.seal('NICHOLAS')
    const tampered = Buffer.from(sealed)
    const last = tampered.length - 1
    tampered.writeUInt8(tampered.readUInt8(last) ^ 1, last)
    expect(() => pii.open(tampered)).toThrow(DecryptionError)
    expect(() => createSealer(randomBytes(32).toString('hex'), 'pii').open(sealed)).toThrow(DecryptionError)
  })

  it('refuses short keys; digests are stable per purpose', () => {
    expect(() => createSealer('abcd', 'pii')).toThrow()
    const pii = createSealer(key, 'pii')
    expect(pii.digest('x').equals(pii.digest('x'))).toBe(true)
    expect(pii.digest('x').equals(createSealer(key, 'other').digest('x'))).toBe(false)
  })

  it('safeEqual', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
  })
})
