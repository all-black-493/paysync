#!/usr/bin/env sh
set -eu
dir="$(dirname "$0")/../secrets"
umask 022
for example in "$dir"/*.example; do
  target="${example%.example}"
  [ -e "$target" ] && continue
  # 0644 so the postgres container (uid 999) can read it; the directory is 0700.
  od -An -tx1 -N32 /dev/urandom | tr -d ' \n' > "$target"
  echo "generated $(basename "$target")"
done
chmod 700 "$dir"
