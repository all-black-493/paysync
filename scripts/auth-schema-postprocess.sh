#!/usr/bin/env sh
# The Better Auth CLI emits public-schema tables with naive timestamps; move them
# into the `auth` schema and use timestamptz.
set -eu
f="${1:-packages/db/src/schema/auth.ts}"
sed -i \
  -e 's/^  pgTable,$/  pgSchema,/' \
  -e 's/= pgTable(/= authSchema.table(/' \
  -e 's/timestamp("\([a-z_]*\)")/timestamp("\1", { withTimezone: true })/' \
  "$f"
grep -q '^export const authSchema' "$f" ||
  sed -i '0,/^} from "drizzle-orm\/pg-core";$/s//} from "drizzle-orm\/pg-core";\n\nexport const authSchema = pgSchema("auth");/' "$f"
if grep -q 'pgTable\|timestamp("[a-z_]*")' "$f"; then echo "auth schema post-processing incomplete" >&2; exit 1; fi
