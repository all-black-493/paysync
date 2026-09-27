import { constants, publicEncrypt, X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { DarajaEnvironment } from './client.js'

const CERTS: Record<DarajaEnvironment, string> = {
  sandbox: fileURLToPath(new URL('../certs/sandbox.cer', import.meta.url)),
}

/** Safaricom's public certificate for encrypting initiator passwords (downloaded from the Daraja portal). */
export function darajaCertificate(environment: DarajaEnvironment): string {
  return readFileSync(CERTS[environment], 'utf8')
}

/**
 * The initiator password encrypted with Safaricom's public key (RSA, PKCS #1
 * v1.5 padding, base64), per the portal. Kept in memory only, never logged.
 */
export function createSecurityCredential(initiatorPassword: string, certificatePem: string): string {
  // The sandbox certificate expired in 2016; only its public key is used.
  const key = new X509Certificate(certificatePem).publicKey
  return publicEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(initiatorPassword, 'utf8')).toString('base64')
}
