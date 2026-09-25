// Next.js static export inlines bootstrap scripts; allow exactly those by hash
// instead of 'unsafe-inline'. Writes a Caddy snippet next to the export.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [outDir, target] = process.argv.slice(2)
if (!outDir || !target) throw new Error('usage: web-csp.mjs <export dir> <snippet file>')

const hashes = new Set()
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path)
    else if (entry.name.endsWith('.html')) {
      for (const [, body] of readFileSync(path, 'utf8').matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
        if (body) hashes.add(`'sha256-${createHash('sha256').update(body).digest('base64')}'`)
      }
    }
  }
}
walk(outDir)

const policy = [
  "default-src 'self'",
  `script-src 'self' ${[...hashes].sort().join(' ')}`,
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ')
writeFileSync(target, `header Content-Security-Policy "${policy}"\n`)
console.log(`CSP allows ${hashes.size} inline scripts`)
