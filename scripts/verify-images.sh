#!/usr/bin/env sh
set -eu
tag="${IMAGE_TAG:-local}"
docker compose -f compose.yaml build api worker migrate web proxy >/dev/null

fail=0
check() { # name, command...
  name="$1"; shift
  if "$@"; then echo "ok   $name"; else echo "FAIL $name" >&2; fail=1; fi
}

for svc in api worker migrate; do
  img="paysync/$svc:$tag"
  run() { docker run --rm --network none --entrypoint sh "$img" -c "$1"; }
  check "$svc runs as non-root"       test "$(run 'id -u')" != 0
  check "$svc has no dev dependencies" test -z "$(run 'ls node_modules/.pnpm 2>/dev/null | grep -E "^(typescript|vitest|eslint|@types\+|typescript-eslint|drizzle-kit|esbuild|@paysync\+test-utils)@" || true')"
  check "$svc has no npm/corepack"    test -z "$(run 'command -v npm corepack npx yarn || true')"
  check "$svc has no .env or secrets" test -z "$(run 'find /app -name ".env*" -o -name "*.pem" -o -path "*/secrets/*" | head -1')"
  check "$svc has no test files"      test -z "$(run 'find /app/dist -name "*.test.*" | head -1')"
  check "$svc ships the migration journal" test -n "$(run 'ls node_modules/@paysync/db/migrations/meta/_journal.json 2>/dev/null')"
  check "$svc app files not writable" test "$(run 'test -w /app/dist/main.js && echo writable || echo ro')" = ro
done
for svc in web proxy; do
  check "$svc runs as non-root" test "$(docker run --rm --network none --entrypoint id "paysync/$svc:$tag" -u)" != 0
done

exit $fail
