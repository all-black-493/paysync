// Every third-party module a package imports must be declared in that package's
// own package.json. pnpm's strict layout only resolves declared dependencies, so
// an undeclared import that happens to work locally breaks in a deployed image.
import { builtinModules } from 'node:module'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', 'out', 'coverage', '__snapshots__'])
const SOURCE = /\.(ts|tsx|mts|js|mjs)$/
const TEST_FILE = /\.(test|int\.test|test\.support)\.(ts|tsx)$|(^|\/)(vitest|eslint|drizzle|next)\.config\.(ts|js|mjs)$|(^|\/)auth\.cli\.ts$/
const IMPORT = /(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g
const builtins = new Set(builtinModules)

function packageName(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) return null
  const parts = specifier.split('/')
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  return builtins.has(name) ? null : name
}

function sourceFiles(dir, nested = false) {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || entry.startsWith('.') && entry !== '.pnpmfile.mjs') continue
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      // Workspace packages are checked against their own manifest.
      if (nested || !['apps', 'packages', 'docker', 'secrets', 'data', 'skills'].includes(entry)) out.push(...sourceFiles(path, true))
    } else if (SOURCE.test(entry) && !entry.endsWith('.d.ts')) out.push(path)
  }
  return out
}

function check(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const runtime = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})])
  const dev = new Set(Object.keys(manifest.devDependencies ?? {}))
  const problems = []
  for (const file of sourceFiles(dir, dir !== root)) {
    const rel = relative(root, file)
    const isTest = TEST_FILE.test(rel)
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(IMPORT)) {
      const name = packageName(match[1] ?? match[2])
      if (!name || name === manifest.name) continue
      if (runtime.has(name)) continue
      if (dev.has(name) && (isTest || /import\s+type\s/.test(match[0]) || dir === root)) continue
      problems.push(`${rel}: imports "${name}" but ${manifest.name ?? 'root'} does not declare it${dev.has(name) ? ' as a runtime dependency' : ''}`)
    }
  }
  return problems
}

const packages = ['apps', 'packages'].flatMap((group) =>
  readdirSync(join(root, group))
    .map((name) => join(root, group, name))
    .filter((dir) => statSync(join(dir, 'package.json'), { throwIfNoEntry: false })),
)
const problems = [root, ...packages].flatMap(check)
if (problems.length > 0) {
  console.error(`Undeclared dependencies:\n  ${problems.join('\n  ')}`)
  process.exit(1)
}
console.log(`dependency declarations ok (${packages.length + 1} manifests)`)
