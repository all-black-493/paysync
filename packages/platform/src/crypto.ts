import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'

const VERSION = 1
const IV_BYTES = 12
const TAG_BYTES = 16

export class DecryptionError extends Error {
  constructor() {
    super('ciphertext could not be decrypted')
    this.name = 'DecryptionError'
  }
}

export interface Sealer {
  seal(plaintext: string): Buffer
  open(ciphertext: Buffer): string
  /** Keyed hash for equality lookups on sealed values. */
  digest(value: string): Buffer
}

/**
 * AES-256-GCM with a key derived per purpose from the master key, so the same
 * master key never encrypts two kinds of data directly.
 */
export function createSealer(masterKeyHex: string, purpose: string): Sealer {
  const master = Buffer.from(masterKeyHex, 'hex')
  if (master.length !== 32) throw new Error('the data encryption key must be 32 bytes (64 hex characters)')
  const key = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), `paysync:${purpose}:enc`, 32))
  const macKey = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), `paysync:${purpose}:mac`, 32))
  const aad = Buffer.from(purpose)

  return {
    seal(plaintext) {
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      cipher.setAAD(aad)
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body])
    },
    open(ciphertext) {
      if (ciphertext.length < 1 + IV_BYTES + TAG_BYTES || ciphertext[0] !== VERSION) throw new DecryptionError()
      const iv = ciphertext.subarray(1, 1 + IV_BYTES)
      const tag = ciphertext.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES)
      const decipher = createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAAD(aad)
      decipher.setAuthTag(tag)
      try {
        return Buffer.concat([decipher.update(ciphertext.subarray(1 + IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8')
      } catch {
        throw new DecryptionError()
      }
    },
    digest(value) {
      return createHmac('sha256', macKey).update(value).digest()
    },
  }
}

/** Constant-time string comparison that does not leak the length of `expected`. */
export function safeEqual(actual: string, expected: string): boolean {
  const a = createHmac('sha256', 'compare').update(actual).digest()
  const b = createHmac('sha256', 'compare').update(expected).digest()
  return timingSafeEqual(a, b)
}
