// better-auth declares optional peers on dev and framework tooling. When they
// are present anywhere in the workspace, pnpm binds them into better-auth's
// resolution and `pnpm deploy --prod` ships them (vitest, drizzle-kit and three
// esbuild binaries) in the api image. Keep only the peers used at runtime.
const BETTER_AUTH_RUNTIME_PEERS = new Set(['pg', 'drizzle-orm', 'react', 'react-dom'])

const keepRuntime = (record) =>
  record && Object.fromEntries(Object.entries(record).filter(([name]) => BETTER_AUTH_RUNTIME_PEERS.has(name)))

// graphile-worker and its config loader take TypeScript as an optional peer for
// loading .ts config and task files, which we do not use (tasks are compiled).
const DROP_TYPESCRIPT_PEER = new Set(['graphile-worker', 'graphile-config', 'cosmiconfig'])

const without = (record, name) => record && Object.fromEntries(Object.entries(record).filter(([key]) => key !== name))

function readPackage(pkg) {
  if (pkg.name === 'better-auth') {
    pkg.peerDependencies = keepRuntime(pkg.peerDependencies)
    pkg.peerDependenciesMeta = keepRuntime(pkg.peerDependenciesMeta)
  }
  if (DROP_TYPESCRIPT_PEER.has(pkg.name)) {
    pkg.peerDependencies = without(pkg.peerDependencies, 'typescript')
    pkg.peerDependenciesMeta = without(pkg.peerDependenciesMeta, 'typescript')
  }
  return pkg
}

export const hooks = { readPackage }
