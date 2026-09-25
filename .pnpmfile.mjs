// better-auth declares optional peers on dev and framework tooling. When they
// are present anywhere in the workspace, pnpm binds them into better-auth's
// resolution and `pnpm deploy --prod` ships them (vitest, drizzle-kit and three
// esbuild binaries) in the api image. Keep only the peers used at runtime.
const BETTER_AUTH_RUNTIME_PEERS = new Set(['pg', 'drizzle-orm', 'react', 'react-dom'])

const keepRuntime = (record) =>
  record && Object.fromEntries(Object.entries(record).filter(([name]) => BETTER_AUTH_RUNTIME_PEERS.has(name)))

function readPackage(pkg) {
  if (pkg.name === 'better-auth') {
    pkg.peerDependencies = keepRuntime(pkg.peerDependencies)
    pkg.peerDependenciesMeta = keepRuntime(pkg.peerDependenciesMeta)
  }
  return pkg
}

export const hooks = { readPackage }
