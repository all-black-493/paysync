# NOTES

Decisions, doc discrepancies, Daraja quirks and open questions (AGENTS.md §3.7).
Newest milestone first.

---

## M0: Skeleton (Docker-first) — done 2026-09-25

### Done-when evidence

| Check | How it was verified | Result |
|---|---|---|
| Clean clone → `make up` → every service healthy | Exported exactly the files git would commit (no `.env`, no secrets, no `dist`) to a scratch dir, ran `make up` under a separate Compose project | db, api, worker, web, proxy `healthy`; migrate `Exited (0)` |
| Clean clone → `make test` passes | Same scratch dir | 37/37 (24 unit, 13 integration) |
| Runtime images non-root, no dev deps | `make verify-images` | api/worker/migrate uid 1000, web/proxy uid 65534; no typescript/vitest/eslint/@types/test-utils in `node_modules`; no npm/corepack/yarn; no `.env`/secrets/test files; app files not writable |
| Gates actually fail | Temporary probe with a thrown literal, `as unknown as`, an empty catch and a failing test | `make lint` exit 2 (4 errors), `make test` exit 2 |
| Stable | `make test` run 3× from clean | 3/3 green |
| Behaviour | curl through proxy, `docker compose stop api` | `/` 200 (web), `/api/*` → api 404 JSON, `/readyz` ready; SIGTERM → drain → close server → close pool → exit 0 |
| Isolation | `wget db` from `web`; outbound fetch from `worker` | db unresolvable from edge network; worker has no egress |
| Vulnerabilities | `make scan` (Trivy 0.74.0) | 0 fixable CRITICAL in all five images |
| CI workflow | `actionlint 1.7.12` | clean. **Not executed**: repo has no remote yet |

### What exists

- **Workspace:** pnpm 12.6.0 (hash-pinned `packageManager`), TypeScript project references (packages `composite`, apps reference them, per oRPC Monorepo Setup recipe), `strict` + `noUncheckedIndexedAccess`.
- **Packages:** `platform` (Zod config + `*_FILE` secrets, Pino logger with redaction, `/healthz` + `/readyz`, graceful shutdown), `db` (pool, drizzle-kit migrations with a guarded runner, baseline migration), `test-utils` (per-file DB cloned from the migrated template).
- **Apps:** `api` (health routes only; oRPC mounts here in M1), `worker` (health + DB readiness; graphile-worker in M3), `migrate` (one-shot), `web` (static placeholder).
- **Docker:** one multi-stage `Dockerfile` (base → deps → build → api/worker/migrate/dev; caddy-base → web/proxy), `compose.yaml`, `compose.override.yaml`, `compose.test.yaml`, Postgres 18.6 with roles from `docker/postgres/init`.
- **Make targets:** `up dev down logs ps build migrate db-generate db-migration db-shell db-reset db-dump db-restore test test-integration test-unit lint typecheck verify-images smoke scan sbom check lock simulate* bench* clean` (*stubs that fail with "not implemented yet").

### Pinned versions (2026-09-25)

| What | Pin | Why this one |
|---|---|---|
| Node image | `node:24.21.0-bookworm-slim@sha256:0e0ff40c…` | Node 24 LTS |
| Postgres image | `postgres:18.6-bookworm@sha256:3725f4e2…` | Current 18.x minor |
| Caddy image | `caddy:2.11.4-alpine@sha256:6aeddd44…` | web + proxy |
| Dockerfile frontend | `docker/dockerfile:1.27@sha256:bde3983e…` | |
| Trivy image | `aquasec/trivy:0.74.0@sha256:62b1e65e…` | |
| pnpm | 12.6.0 | `latest` tag |
| TypeScript | **6.0.3** (not 7.0.2) | typescript-eslint 8.70.1 peer is `typescript <6.1.0` |
| Vitest | **4.1.11** (not 5.0.2) | 5.0.2 was published the day of pinning; 5.x also needs a separate `vite` peer. Revisit after M1. |
| ESLint / typescript-eslint | 10.11.0 / 8.70.1 | |
| Zod | 4.6.5 | Check oRPC v2's Zod integration requirement in M1 |
| pg / @types/pg | 8.23.0 / 8.23.1 | |
| Pino | 10.3.1 | |
| drizzle-orm / drizzle-kit | 0.45.3 / 0.31.11 | Owner chose 0.45 over the 1.0 rc; kit 0.31 is the matching stable line |
| @types/node | 24.13.6 | Matches Node 24 |

GitHub Actions are pinned by commit SHA: checkout v7.0.1, setup-buildx v4.4.1, upload-artifact v7.0.1.

### Decisions and deviations from AGENTS.md

1. **Extra packages `platform` and `test-utils`** (not in §10). `platform` holds config, logging, health and shutdown code that api, worker and migrate all need. `test-utils` is a devDependency only and never ships.
2. **Migrations: drizzle-kit** (owner decision, 2026-09-26). `make db-generate NAME=x` diffs the Drizzle schema (`packages/db/src/schema`); `make db-migration NAME=x` creates an empty file for hand-written SQL (constraints, triggers, roles, RLS). Both run drizzle-kit in the `dev` image as the host user, with only `packages/db/migrations` mounted. Every generated file is reviewed like hand-written SQL. At runtime `migrate` uses drizzle-orm's `migrate()`, wrapped (`packages/db/src/runner.ts`) to add what drizzle lacks (read from the 0.45.3 source):
   - it does not detect edited migrations → we compare stored hashes and refuse;
   - it silently **skips** a migration older than the newest applied one (merged branches) → we refuse and ask for regeneration;
   - advisory lock, `SET ROLE paysync_owner`, and read grants on `meta.schema_migration` for readiness.
   Limits: drizzle applies all pending migrations in **one transaction**, so `CREATE INDEX CONCURRENTLY` cannot go through it. When first needed, add a separate non-transactional step and log it here. File names are `YYYYMMDDHHMMSS_name.sql` (drizzle `prefix: 'timestamp'`, UTC), not the 12-digit form in §6B.7.
3. **DATABASE_URL carries no password.** The password comes from `DATABASE_PASSWORD_FILE`. Found in testing: node-postgres lets `connectionString` override an explicit `password`, so the URL is split into host/port/user/database (`databaseConnectionParams`). Query parameters are rejected for now so nothing (e.g. `sslmode`) is silently ignored; TLS options come with managed Postgres in M11.
4. **`make test` uses `docker compose run`,** not `up --abort-on-container-exit --exit-code-from test` (§6A.5). `--exit-code-from` implies abort-on-exit, and the one-shot `migrate` exiting 0 would abort the run. `run` returns the test container's exit code. On failure the Makefile prints the `migrate` logs.
5. **Every test/smoke Compose call has its own `-p` project.** Found while simulating the clean clone: with `COMPOSE_PROJECT_NAME` set, `make test`'s `down --volumes` tore down the dev stack. `-p` beats the env var, and I verified the dev stack survives even with `COMPOSE_PROJECT_NAME=paysync`.
6. **`compose.override.yaml` keeps the production images.** It only adds loopback ports (db 5432, api 3000) and `develop.watch` rebuild rules. So `make up` runs the real runtime images, and the `dev` stage is used only by lint/typecheck/test. The `dev` stage runs as root; it is never deployed.
7. **Caddy serves both `web` and `proxy`.** The upstream binary has the `cap_net_bind_service` file capability, and with `cap_drop: ALL` + `no-new-privileges` the kernel refuses to exec it. The `caddy-base` stage copies the binary to drop the xattr. Both listen on 8080 as uid 65534. Serving TLS on 443 in production needs a decision in M11 (host port mapping 443→8080 or adding the capability back). Cost: the copy duplicates the ~40 MB binary in a layer.
8. **Worker has no egress in M0** (`internal` network only). M2/M3 must add an egress network for Daraja and TypeSafe calls.
9. **Compose profiles:** only `tools` (psql) exists now. `observability` is deferred until there is telemetry to view; `tunnel` is deferred to M2.
10. **Secret files are 0644 inside a 0700 `secrets/` dir,** because the postgres container (uid 999) must read files owned by the host user. Dev only; production uses a real secret store.
11. **ESLint:** both core `no-throw-literal` (required by §8.2) and the type-aware `@typescript-eslint/only-throw-error` are on, so each violation is reported twice. `as unknown as` is banned with a `no-restricted-syntax` selector, and empty catch blocks with `no-empty`.
12. **Runtime images** have npm, npx, corepack and yarn removed. App files are root-owned and read-only to `node`.
13. **Trivy runs from a digest-pinned image,** not `aquasecurity/trivy-action` (one less third-party action; that action has had tag-hijack incidents). It fails on **fixable** CRITICALs (`--ignore-unfixed`); without that flag, unfixed base-image CVEs would keep CI permanently red.
14. **CI does not push images or use a BuildKit layer cache yet.** No registry has been chosen (M11). Every job uses `IMAGE_TAG=<sha>`.
15. **pnpm 12 downloads a native binary** through its corepack shim, verified against npm registry signatures (`get-pnpm`). The `base` stage runs `pnpm --version` once so later layers never download it. pnpm 11+ defaults: `minimumReleaseAge` of 1 day (brand-new versions are not resolvable), settings only in `pnpm-workspace.yaml`, and `allowBuilds` (`esbuild: false`: its postinstall only checks the platform binary, which pnpm installs as an optional dependency; drizzle-kit works without it).
16. **`make typecheck` = `tsc -b --force`** (build and typecheck are the same `tsc -b`). Test files are typechecked too; they compile into `dist` but are excluded from what ships (`files` + checked by `verify-images`).

### Doc discrepancies and facts found (for later milestones)

- **oRPC:** npm `latest` is still 1.15.4; v2 is on the `beta` tag (2.0.0-beta.40, 2026-09-23). Pin the beta exactly in M1.
- **oRPC:** "Request Validation" and "Response Validation" are **client-side** plugins (they validate on the client against the contract). §9.1 lists them under server hardening. Resolve in M1.
- **oRPC:** v2 metadata uses `defineMeta` or a custom `MetaPlugin`. This affects how `AgentMeta` (§8.1) is declared.
- **oRPC:** Rate Limit, Signing, Lock and Publisher are "Helpers" and exist. There is also a client-side Dedupe *Plugin*, separate from the Dedupe *Middleware* recipe that §8.3 means.
- **TypeSafe:** there is an official JS SDK (`@typesafe-ai/sdk` 0.6.0) with typed `choice()`/`score()`/`noul()`. §6 says "TypeSafe HTTP API". Question below.
- **AI SDK:** v7 is GA (`ai` 7.0.114), not beta.
- **Better Auth:** 1.7.6 is latest; its `drizzle-orm` peer accepts `^0.45.2` or `>=1.0.0-rc.1`.
- **graphile-worker:** 0.18.0 requires Node ≥ 22.18 (fine on Node 24).
- **drizzle-orm:** stable is 0.45.3; 1.0 is at rc.4. Choose in M1.
- **Postgres 18 image:** data lives in `/var/lib/postgresql/18/docker`; the volume mounts `/var/lib/postgresql`.
- **Postgres 18:** `log_connections` is list-valued now (we use `'authentication'`).

### [VERIFY] items settled in M0

- pnpm `deploy` flags (§6A.1): since pnpm 12.2, `pnpm --filter <app> --prod deploy <dir>` works **without** `injectWorkspacePackages`; `--legacy` selects the old behaviour. Verified by building.
- Compose `develop.watch` syntax (§6A.4): `path` / `action: rebuild` / `ignore`. Checked against the Docker docs; `docker compose config` accepts it.
- Postgres 18 built-in `uuidv7()` (§6B.1): verified on 18.6 (`uuid_extract_version(uuidv7()) = 7`).

### Daraja quirks

None yet (M2).

### Owner answers (2026-09-26)

- **Name:** the project is **paysync** (the local folder is still named `payasync`).
- **Sandbox callbacks:** tunnel with **ngrok** (sandbox only; never production, §5.3.1). Added as the `tunnel` profile in M2. The ngrok hostname must not contain the banned words.
- **Web frontend:** **React + Next.js + TanStack Query.** §6 wants `web` built to static assets. Plan: Next.js static export (`output: 'export'`) served by the existing Caddy `web` image, with a client-side oRPC client + TanStack Query. If a feature needs a Next.js server (SSR, route handlers), revisit and log it here.
- **Git:** commit freely. No AI co-author or attribution lines in commits or PRs.
- **Agent tool folders** (`.agents/`, `.claude/`, …, `data/`, `skills/`) are git-ignored and excluded from the Docker build context.
- **Code style:** no noisy comments; comment only a non-obvious *why*.
- **Daraja sandbox credentials** are in `.env` as `CONSUMER_KEY`, `CONSUMER_SECRET`, `SHORTCODE`, `PASSKEY`. At the start of M2 the three secrets move to `secrets/daraja_*` files (§6A.3); the shortcode stays in `.env` as `DARAJA_SHORTCODE`.

- **Migrations:** drizzle-kit, with **Drizzle 0.45** (see decision 2).
- **Git remote:** `https://github.com/all-black-493/paysync.git` (also the OCI `image.source` label).

- **Jev access:** the official **TypeSafe JS SDK** (`@typesafe-ai/sdk`, 0.6.0 on 2026-09-26), wrapped by `packages/decisions` as the only importer (§3.4). Pin the exact version when M6 starts.
- **Git push:** this machine's git `store` credentials belong to another GitHub account; push with `git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push` (uses the active `gh` account, all-black-493).

Still open (owner will decide later): what M2's "exactly one **verified** transaction per receipt" means, given verification (§5.4) is M3.

### Fixes after M0

- `make db-dump` / `make db-restore` ran as root inside the db container, which peer auth rejects. They now run as `postgres`; dump → restore verified.

### Next step

M1 (Domain + ledger + contract): waiting for the owner's go-ahead.
