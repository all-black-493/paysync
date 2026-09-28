# NOTES

Decisions, doc discrepancies, Daraja quirks and open questions (AGENTS.md §3.7).
Newest milestone first.

---

## M3: Verification + sweeps — done 2026-09-28

### Done-when evidence

"A deliberately 'missed' callback is recovered by a sweep with exactly one posting."

| Check | How | Result |
|---|---|---|
| Missed C2B confirmation recovered | `recovery.int.test.ts`: payment exists only at "Safaricom" (fake Daraja Pull); `sweep_pull` → `pull_transactions` job (paged, 3 records) → transaction created `verified` (`pull`) with its receipt journal; then the confirmation arrives twice and the sweep runs again over an overlapping window | 1 transaction and 1 `receipt` journal per receipt; 1 inbound event per source |
| Callback + sweep race | 6 receipts × (2 confirmations + 2 Pull ingestions) concurrently | 1 transaction, `verified`, 1 journal each |
| Missed STK callback | open push, no callback; `sweep_stk_requests` → STK Query "0" → push `succeeded` + high-priority `missing_callback` (no receipt yet); Pull then supplies the receipt | 1 journal; sweep does not re-query |
| Early callback re-routed | STK callback before its CheckoutRequestID was saved (stored unrouted) → the STK check re-routes it → verified | 1 journal |
| Verification paths | `verification.int.test.ts`: Transaction Status match / amount mismatch / other shortcode / not Completed / result before ConversationID saved / queue timeout then re-drive / non-success code / attempts exhausted; STK Query success (4 concurrent verifications → 1 posting), cancelled, amount ≠ push, still pending; balance snapshots + variance; failed job → exception | all pass |
| Outbox | `hooks.int.test.ts`: every transaction created by a callback has exactly one `verify_transaction` job, enqueued in the callback's DB transaction | pass |
| Running stack | `make up`: migrate installs the queue schema; worker starts with the crontab; at 23:00 UTC `sweep_unverified` queued the 4 pending M2 transactions and ran them against the real sandbox (still pending: fixture checkouts are unknown to Daraja, and no public URL for Transaction Status results) | as expected |
| Suite | `make test` 188 passed; lint + dependency check, typecheck, verify-images (23), smoke, scan | green |

The recovery tests run real Postgres 18 and graphile-worker's own `runOnce`; only Daraja is faked (`FakeDaraja` in `apps/worker/src/harness.test.support.ts`), because Pull Transactions is not available to our sandbox app (below) and the sandbox never completes an STK payment to its test number.

### What exists

- **Money gate** (`apps/worker/src/verification.ts`): `markVerified` is the only path from `pending_verification` to `verified` and the only place a receipt is posted (debit `mpesa_float`, credit `suspense`, journal key `receipt:<transactionId>`). It locks the row and acts only on pending rows; the journal key and receipt uniqueness make a second posting impossible. `failVerification` sets `verification_failed` and raises a high-priority exception, no ledger credit.
- **How each source is verified:**
  - STK: STK Query `ResultCode "0"` **and** the callback amount equals the amount we pushed (STK Query returns no amount or receipt). Cancelled/failed → `verification_failed`; pending/unknown → stay pending.
  - C2B: Transaction Status by receipt, answered on `/hooks/result/txn/:secret`. Verified only if result code 0, same receipt, same amount, `TransactionStatus = Completed`, and (when present) `CreditPartyName` starts with our shortcode. Any mismatch → `verification_failed`. **Any other result code stays pending** (e.g. a rejected initiator says nothing about the payment): fail closed.
  - Pull: a record we fetched from Safaricom creates the transaction already verified, or verifies/fails a pending one by amount.
- **Transactional outbox:** `insertTransaction` enqueues `verify_transaction` (job key `verify:<id>`) in the same DB transaction as the transaction row; result bodies enqueue `apply_daraja_result` the same way. Callback handling itself stays synchronous and DB-only (M2).
- **Worker tasks:** `verify_transaction`, `apply_daraja_result`, `check_stk_request`, `pull_transactions`, `request_balance`. Retries with graphile's backoff (3–8 attempts by task); a job out of retries becomes a high-priority `job_failed` exception (`job:failed` event).
- **Crontab (UTC):** `sweep_unverified` and `sweep_stk_requests` every 10 min, `sweep_pull` hourly at :07, `sweep_balances` 15:00 (18:00 EAT). Sweeps visit each organization in its own RLS scope and only enqueue keyed jobs. After 12 unsuccessful verification attempts a normal-priority "could not be verified" exception is raised and the sweep stops (the payment stays pending; a late result can still verify it).
- **Result URLs:** `POST /hooks/result/{txn|balance}/:secret` and `/hooks/timeout/{txn|balance}/:secret`, same rules as the M2 routes. Outbound async requests are recorded in `ingest.daraja_request` before the call; results are routed by ConversationID/OriginatorConversationID (`ingest.route_daraja_conversation`, `SECURITY DEFINER`). A result that beats its ConversationID is stored as `unknown_conversation` and re-routed by the job that sent the request (`rerouteUnrouted`); the same for early STK callbacks.
- **Account balance:** snapshots in `core.balance_snapshot` (append-only). Variance = change in (utility + working + charges paid) minus verified receipts between snapshots; non-zero → high-priority `balance_variance`.
- **Personal data:** `DebitPartyName`/`CreditPartyName` result parameters are sealed like MSISDN and names.
- `@paysync/ingest` (new) holds callback/result ingestion, shared by the api (hooks) and the worker (re-routing, Pull). The worker is the only long-running service on the `egress` network.
- Web: the new status shows as a red "verification failed" badge.

### Decisions

- **graphile-worker 0.18.0** (pinned; §6 lists it). Its schema lives in `jobs` and is installed by the `migrate` container as `paysync_owner` (`installJobQueue`), never by the app role. graphile enables row-level security on its private tables with no policies, so `installJobQueue` adds `app_worker` policies (app role only) and grants DML there; `add_job` is called directly, as the docs require for non-owner roles once grants exist. A worker that finds the queue schema outdated cannot migrate it and fails to start.
- The TypeScript optional peer of graphile-worker/`cosmiconfig` is dropped in `.pnpmfile.mjs` (like better-auth's), so runtime images keep no dev dependencies.
- Transaction status `verification_failed` and exception kind `missing_callback` added; `Transaction.verifiedAt` added to the contract. Additive, contract not yet released (snapshot reviewed).
- The migration backfills `verified_at` for rows verified before M3 (seed data only), bumping `version` as the trigger requires. Seeded verified transactions now also post their receipt journal; **existing dev databases** keep six seeded verified transactions without journals (`make db-reset && make seed` to rebuild).
- Verification timings live in `apps/worker/src/deps.ts` (`DEFAULT_POLICY`) until `config/policy.ts` arrives with matching/guard.
- Initiator: `DARAJA_INITIATOR_NAME` (env) + `secrets/daraja_initiator_password`; the security credential is generated in memory at worker start from Safaricom's sandbox certificate (committed at `packages/daraja/certs/sandbox.cer`, a public key). Without a name or without `CALLBACK_BASE_URL`, Transaction Status and Account Balance are skipped and payments wait for Pull.

### Daraja findings (sandbox, 2026-09-28)

- Transaction Status and Account Balance with initiator `testapi` both answer synchronously `ResponseCode "0"`, "Accept the service request successfully." (`OriginatorConversationID` like `8423-4a3b-87d8-1d918a78741e243712`, `ConversationID` like `AG_20260928_0100101002hi3i67m6ml`). The acknowledgement does not check the credential; the verdict comes on the Result URL. **[VERIFY]** result bodies once a tunnel is up.
- **Pull Transactions query returns HTTP 401 `401.001` "Invalid Access Token"** with a token that works for every other product: the sandbox app is not subscribed to Pull (the portal says Pull registration needs a live shortcode). Pull is implemented against the documented shapes and tested with the fake only.
- The sandbox certificate from the portal (`/certificates/SandboxCertificate.cer`, CN `apicrypt.safaricom.co.ke`) **expired in 2016**; only its public key is used. Whether Daraja still decrypts with the matching key shows in the first real result.
- Documented Transaction Status result sample repeats `DebitPartyName` (the second is presumably the credit party) and uses a B2C example; the Account Balance sample has string `ResultCode`, the Transaction Status sample a number. Handled per product.
- Pull request dates are `YYYY-MM-DD HH:mm:ss` (taken as EAT); records carry `trxDate` with a `Z` suffix **[VERIFY whether it is really UTC]**. The documented record's `transactionId` (`yzlyrEsRG1`) is not a receipt format; such records are stored unrouted and skipped.
- The Getting Started page lists 12 Safaricom gateway IPs for callback whitelisting (196.201.214.200, .206, .207, .208, 196.201.213.114, .44, 196.201.212.127, .138, .129, .136, .74, .69). Not enabled: owner to confirm with Safaricom (§5.3.4), sandbox stays open.

### Third-party Daraja skill vs our rules

The owner added a third-party Daraja skill (`.claude/skills/...mpesa-daraja`). Where it differs from the portal or AGENTS.md we follow those: it says to always answer callbacks 200 even if processing fails (we answer 500 when the payload was not stored, §5.3.7); it uses `/mpesa/c2b/v1/registerurl` (portal documents v2); its `test_credentials` link is a 404; its claim that the sandbox callback delivery is unreliable is **[VERIFY]**.

### Tunnel session (2026-09-28, after M3)

- ngrok authtoken copied from the owner's ngrok CLI config into `secrets/ngrok_authtoken`; tunnel at the static dev domain `https://salvatore-mythical-dishonorably.ngrok-free.dev` (`CALLBACK_BASE_URL` in `.env`).
- The tunnel now only forwards `/hooks/*` (ngrok traffic policy; everything else gets ngrok's empty 404), so the web app and API are not public. Checked from outside: `/` and `/api/rpc` → ngrok 404; `/hooks/stk/<wrong>` → our 404 body.
- **C2B Register URL was down for 30+ minutes**: v1 and v2, with `example.com` and with the ngrok URL alike → HTTP 500 `500.003.1001` "Service is currently unreachable. Please try again later." A sandbox outage, not an ngrok block. Retry `make daraja ARGS=register-c2b`.
- The worker sent 3 real Transaction Status requests through the Result URL at 23:50 UTC (accepted, `ResponseCode "0"`), with the placeholder initiator password. **No result or timeout reached the tunnel within 25 minutes.** Either Daraja sends nothing for a rejected credential or sandbox results are slow; re-check with the real test password. The payments stay pending (as designed); the sweep gives up after 12 attempts with an exception.

### First real Transaction Status result (2026-09-28 10:58 UTC)

- The owner set the sandbox initiator password (`secrets/daraja_initiator_password`, name `testapi`). After `compose down` / `make up`, one `verify_transaction` job was queued by hand for the M2 test receipt `RKL51ZDR4F` (its sweeps had run out of attempts).
- Daraja answered the first two requests with HTTP 500 "Service is temporarily unavailable. Please try again later" (sandbox outage, same morning C2B register still returned "Service is currently unreachable"); graphile's retry sent the third, accepted at 10:56:40.
- **Result arrived through the tunnel at 10:58:05** (~85 s) on `/hooks/result/txn/…`, was routed by ConversationID, stored with its organization and applied: `ResultCode 2032` "The transaction receipt number does not exist." (numeric code, `ResultType 0`, no `ResultParameters`). The credential was accepted (a wrong one gives 2001). Captured as fixture `transaction-status-result-not-found`.
- As designed, a non-success code leaves the payment `pending_verification` with no posting. **Owner decision:** should `2032` (receipt unknown to M-Pesa) fail verification outright? It is strong evidence of a forged or mistyped callback, but a receipt may not be queryable immediately after payment [VERIFY on a real payment]; today it ends as the "could not be verified" exception after 12 attempts.
- Still open: C2B Register URL (sandbox outage) and therefore a real C2B confirmation and a successful Transaction Status result.

### Still to verify / owner actions

- **Initiator password:** `secrets/daraja_initiator_password` is a random placeholder; put the sandbox app's test initiator password there (Daraja simulator → test credentials).
- Pull Transactions access (production shortcode registration) and the real Transaction Status / balance / timeout result payloads.
- Balance variance counts withdrawals, settlement charges and reversals as variance until those flows are ingested (statement import); expect false positives on days with withdrawals.

---

## M2: Daraja ingestion (sandbox) — done 2026-09-28

### Done-when evidence

"Duplicate/out-of-order replay produces exactly one verified transaction per receipt."

| Check | How | Result |
|---|---|---|
| One transaction per receipt | `ingest.int.test.ts`: 3 sequential + 8 concurrent duplicate C2B confirmations; confirmation before validation; 5 concurrent duplicate STK success callbacks then the same receipt as a C2B confirmation | 1 transaction per receipt, 1 inbound event per (source, id) |
| Same, against the running stack | `make simulate` twice: every callback fixture ×3, shuffled, 4 concurrent senders (27 deliveries per run) | all acknowledged; `{RKL51ZDR4F:1, RKL51ZDR5G:1, RKL51ZDR6H:1, NLJ7RT61SV:1}` |
| Nothing dropped | unknown shortcode, unknown checkout, invalid payload, bad JSON | stored once each in `ingest.unrouted_event`, acknowledged |
| Not stored → not acknowledged | callback against a database without the schema | HTTP 500, no `ResultCode: 0` |
| Live sandbox | OAuth, STK push/query, C2B simulate (v1 and v2) called with the owner's sandbox app; `make daraja ARGS="stk-query …"` twice | token fetched once and reused across processes from Postgres (encrypted) |
| Suite | `make test` 155 passed; lint + dependency check, typecheck, verify-images (23), smoke, scan | green |

**On "verified":** transactions from callbacks are stored as `pending_verification`. The money gate (STK Query / Transaction Status / Pull, §5.4) is M3, and the owner will confirm what "verified" means for M2's done-when. What M2 guarantees now is exactly one transaction per receipt.

### What exists

- `@paysync/daraja` (the only package that talks to Safaricom): `DarajaClient` (OAuth, STK push, STK query, C2B register, C2B simulate), one Zod schema per product, strict amount and EAT timestamp parsing, normalization to our own outcomes, fixtures with provenance, and a replay simulator.
- Shared OAuth token: `ingest.daraja_token` (AES-256-GCM), refreshed ~5 minutes before expiry under a Postgres **session** advisory lock on a dedicated connection with no open transaction (§6B.5 forbids external calls inside a transaction, so `pg_advisory_xact_lock` from §5.2 is not used). A rejected token triggers one re-read or refresh and a retry.
- Callback routes `POST /hooks/{c2b/validation|c2b/confirmation|stk}/:secret` (secret compared in constant time; wrong secret → 404; optional `CALLBACK_ALLOWED_IPS`; 64 KB body limit). Routing via `SECURITY DEFINER` functions `ingest.route_shortcode` / `ingest.route_stk_checkout`, then everything else in an org-scoped transaction.
- Stored first: `ingest.inbound_event` keeps the body verbatim except personal fields (`MSISDN`, names, STK `PhoneNumber`), which are replaced by `{ "$sealed": <ciphertext> }`. Transactions keep payer name and MSISDN as ciphertext; `bill_ref_number` is stored as untrusted text.
- `ingest.stk_request` records a push before Daraja is called; its callback updates the status and creates the transaction. An amount different from the request raises a high-priority `amount_mismatch` exception.
- Operator tools: `make simulate`, `make daraja ARGS="…"` (the `daraja` tools service is the only one on the new `egress` network with Daraja secrets), `make tunnel` / `make tunnel-url` (ngrok, sandbox only, token from `secrets/ngrok_authtoken`). `make seed` gives Acme the sandbox shortcodes 174379 and 600984.

### Daraja quirks (sandbox, 2026-09-28)

- OAuth `expires_in` is the **string** `"3599"`; the portal documents a number.
- Portal: "each [token] request invalidates the previous token", so replicas must share one token (done, see above).
- STK Query for an unknown `CheckoutRequestID`: HTTP **500**, `errorCode 500.001.1001`, `"The transaction does not Exist"` → our outcome `unknown`, not `failed`.
- STK Query on a valid id intermittently returns HTTP 500 `500.001.1001` with an **empty** `errorMessage` between successful polls → treated as transient and retried.
- STK Query returns `ResultCode "4999"` "The transaction is still under processing" (undocumented) → `pending`. A push to the sandbox test number stayed `4999` for many minutes and later resolved to `1032` "Request Cancelled by user." (the docs spell it "cancelled by user").
- `ResultCode` is a string in STK Query and a number in the STK callback; every product has its own schema.
- C2B simulate: both `/mpesa/c2b/v1/simulate` and `/v2/simulate` answer `ResponseCode "0"`; the portal gives no URL. We use v2, like register (`/mpesa/c2b/v2/registerurl`, which the portal does document).
- The portal documents only the **validation** response body (`{"ResultCode":"0","ResultDesc":"Accepted"}`); confirmation and STK callback acknowledgements are undocumented. We answer confirmations with the same body and STK callbacks with `{"ResultCode":0,"ResultDesc":"Accepted"}`. [VERIFY with captured sandbox callbacks.]
- C2B callbacks carry a **masked** MSISDN (`"2547 ***** 126"`), so it cannot identify a payer (consistent with §4.3).
- Callback URLs must not contain M-PESA, Safaricom, exe, exec, cmd, SQL or **query**; the sandbox accepts HTTP, production requires HTTPS; tunnels such as ngrok are allowed in the sandbox only. Enforced by `assertCallbackUrl`.
- STK: `AccountReference` ≤ 12 characters, `TransactionDesc` ≤ 13 (enforced client-side).

### [VERIFY] items settled in M2

- Timestamps (`TransTime`, STK `TransactionDate`) are `YYYYMMDDHHmmss` in EAT; STK sends a JSON number, C2B a string. Both parse to UTC.
- STK verification route: STK Query returns only a status (no receipt, no amount), so verifying an STK payment = Query `ResultCode "0"` for the CheckoutRequestID **plus** the amount we recorded when initiating it. Input for M3.
- Result codes differ per product in type (string vs number) and meaning; normalized per product.

### Still to verify (needs a public callback URL)

- Real sandbox **callback** payloads (C2B confirmation/validation, STK success/cancel) to replace the "documented"-provenance fixtures, and the ACK behaviour. Blocked on an ngrok authtoken in `secrets/ngrok_authtoken`; then `make tunnel`, put the URL in `.env` as `CALLBACK_BASE_URL`, `make daraja ARGS=register-c2b`, `make daraja ARGS="simulate-c2b --amount 10 --ref TEST"`.
- Whether Daraja blocks ngrok hostnames (§6A.2), whether STK payments to a paybill with registered C2B URLs also trigger a C2B confirmation (handled either way by the receipt constraint), and Safaricom's source IP ranges for `CALLBACK_ALLOWED_IPS` (owner).

### Decisions

- M2 stores and normalizes inside the callback's own transaction (fast, database-only). The transactional outbox with graphile-worker and asynchronous processing arrive in M3 (§6B.6).
- `DARAJA_ENV` accepts only `sandbox`; the client refuses production (no production money movement).
- STK push and C2B simulate are never retried automatically (they can charge a customer); OAuth, STK Query and URL registration retry with jitter.
- A push whose callback arrives before its `CheckoutRequestID` is saved lands in `unrouted_event` (`unknown_checkout`); M3's sweep can re-route it.

---

## Authorization moved to Permix — 2026-09-28

Owner decision: use **Permix** (`permix` 4.3.0, oRPC integration) instead of the bespoke role checks.

- `@paysync/auth` defines `PermissionsDefinition` (entities → actions) and Permix rule sets per role (`ROLE_RULES`, viewer ⊂ clerk ⊂ accountant ⊂ admin = owner) and per integrator scope (`INTEGRATOR_RULES.read` / `.write`). Members with several roles get the union; unknown roles get nothing.
- Better Auth's access control now covers only Better Auth's own resources (organization, members, invitations, API key management); application permissions are Permix only.
- The api builds the caller's rules in its auth middleware and calls `permix.setupContext(rules)` (context key `permix`). Each procedure's required Permix path comes from `PERMISSIONS` in `apps/api/src/orpc/permissions.ts`, which the compiler forces to list every contract procedure. This is used instead of per-procedure `permix.checkMiddleware(...)` so a forgotten check cannot compile. Unmapped paths throw (fail closed).
- `me.get` returns `permissions` (Permix `dehydrate()`); the contract lists every entity and action explicitly, so a drift between the Permix definition and the contract fails to compile on the server (dehydrate) and in the web app (hydrate). The web app hides actions with a hydrated Permix instance; the API still enforces.
- Integrator keys store their scope as `{ paysync: ['read'|'write'] }` in Better Auth's key record.

---

## M1 follow-up: integrator keys, invite-only sign-up — 2026-09-26

Owner decisions: integrator API keys now (no stubs); sign-up invite-only; every package must declare the third-party modules it imports.

- **Integrator API keys** (§6C.1): Better Auth `@better-auth/api-key`, one config `integrator`, **organization-owned** keys with prefix `psk_`, 90-day default expiry (max 365), 600 requests/minute per key (the plugin's default is 10 per day), no session minting. Keys are created only through `apiKeys.create` (owner/admin), which sets one of two fixed scopes (`INTEGRATOR_SCOPES` in `@paysync/auth`): `read` (all reads) or `write` (reads + create/update expected payments + annotate exceptions). A key can never hold destructive, money, approval or key-management permissions. Calls authorize against the scope intersected with those fixed sets. Keys work on REST only (`x-api-key`), not on the RPC surface. Better Auth's own `/api/auth/api-key/*` routes return 404. The secret is returned once; the idempotency record stores the response with `key: null`. Revoking disables the key. Audit rows record the key as `apikey:<id>`. `me.get` now returns an `actor` (`user` or `api_key`); the OpenAPI document declares both security schemes.
- **Invite-only sign-up:** a Better Auth `before` hook rejects HTTP `/sign-up/email` unless the email has a pending, unexpired invitation. Trusted server code (seed, tests) calls `auth.api` directly and is not affected. Owners/admins invite from the web Settings tab and share the `/accept-invitation/?id=…` link (no email sender yet); invitees create an account with the invited address and accept. Better Auth enforces that the accepting session's email matches the invitation.
- **Dependency declarations:** `scripts/check-deps.mjs` (part of `make lint`) fails when any file imports a package its own `package.json` does not declare; runtime files need `dependencies`, tests and tool configs may use `devDependencies`. It found `vitest` used by three packages that relied on the root install; now declared.
- **TypeScript:** Better Auth's instance type (with the org and API key plugins) is too large for declaration emit (TS7056). The auth instance now lives in `apps/api/src/auth.ts`, and apps are non-composite projects (no declaration files; `tsc -b tsconfig.json apps/*`). `@paysync/auth` keeps roles, permissions and scopes, with explicit `AccessControl`/`Role` annotations so the organization plugin still infers our role names.
- `auth` schema: default privileges now give `paysync_app` access to future Better Auth tables; `scripts/auth-schema-postprocess.sh` is idempotent.
- Verified: 99 tests (new: key scopes, RPC refusal, revocation, key cannot manage keys, idempotent create hides the secret, Better Auth key routes closed, sign-up without invitation 403, invited sign-up + accept); browser: key created in Settings, used over REST through the proxy.

---

## M1: Domain, ledger, contract and auth — done 2026-09-26

### Done-when evidence

| Check | How it was verified | Result |
|---|---|---|
| Ledger property tests pass | fast-check: every balanced journal accepted, any single-line change rejected; allocation sequences never exceed the amount and the remainder stays explicit; 30 random journals against Postgres (balanced stored, unbalanced rejected at commit) | green |
| Permission and RLS tests pass | `integrity.int.test.ts` (RLS on read, insert, re-parenting; no org set → no rows; same-org composite FKs) and `api.int.test.ts` (viewer 403, clerk allowed, other org 404, cannot switch into a non-member org) | green |
| A user signs in and sees only their org | API tests over real Better Auth sign-in; manual browser run through Caddy: Acme clerk sees Acme only, Beta owner sees Beta only | done |
| Same procedure from the typed client and via REST | Tests create via RPC and read via REST (identical body) and the reverse; curl through the proxy returns the same list on `/api/rpc/expected/list` and `/api/v1/expected-payments` | done |
| Whole suite | `make test` 88 passed; `make lint`, `make typecheck`, `make verify-images` (23 checks), `make smoke`, `make scan` (0 fixable CRITICAL) | green |

### What exists

- **Schema** (Drizzle, `packages/db/src/schema`): `core` (shortcode, expected_payment, mpesa_transaction, match, allocation, exception), `ledger` (account, journal, entry), `ingest.inbound_event`, `audit.event`, `agent.idempotency_record`, and Better Auth's tables in `auth`.
- **Hand-written migration** `…_tenancy_and_integrity.sql`: grants, RLS, append-only triggers, deferred ledger-balance and allocation checks, match transitions, version bumps.
- **Helpers** (`@paysync/db`): `withOrg` (the only query path; serializable retry), `postJournal` (idempotent), `allocate` (row lock + pure `planAllocation`).
- **`@paysync/auth`**: Better Auth 1.7.6 (email/password, database rate limiting, organizations, roles in `permissions.ts`).
- **`@paysync/contract`** and the api: `/api/auth/*` Better Auth, `/api/rpc/*` typed client, `/api/v1/*` REST, `/api/v1/docs` Scalar (only when `API_DOCS=on` and not production).
- **`apps/web`**: Next.js 16 static export (sign-in, org picker, today's totals, exceptions with notes, expected payments with a create form, transactions).
- **Make targets:** `seed`, `auth-schema`, `snapshots` (plus `db-generate` / `db-migration`).

### Decisions and deviations

1. **Contract scope.** M1 ships `me.get`, `transactions.list/get`, `expected.list/get/create/update`, `exceptions.list/get/annotate`, `matches.list` and `reports.dailySummary`. Not yet in the contract, rather than stubbed: `matches.suggest` and `matches.confirm` (M4, need the matching engine), `reconciliation.run` (M9), and the destructive procedures (M5, need approvals). `dailySummary` has no `variance` yet; it needs the account-balance check (M3).
2. **Money on the wire** is `{ minor: "<integer string>", currency: "KES" }`. BigInt in code, bigint in Postgres, never floats.
3. **Better Auth tables** come from `make auth-schema` (Better Auth CLI → Drizzle), then `scripts/auth-schema-postprocess.sh` moves them into the `auth` schema and makes timestamps `timestamptz`. The CLI ignores the adapter's `schemaName`. Better Auth keeps its own random text ids, so `org_id` is `text`; our own tables use `uuidv7()`.
4. **Same-org composite foreign keys** (`(child_id, org_id) → (id, org_id)`) on every tenant-to-tenant reference, so a row can never point at another org's row, even when written by a superuser.
5. **RLS is `ENABLE`d, not `FORCE`d.** It applies to `paysync_app`; the owner (migrations) is not subject. An unset `app.org_id` returns no rows. The integrity functions are `SECURITY DEFINER` so they see every row.
6. **Append-only:** `ingest.inbound_event`, `ledger.*`, `audit.event`, `core.allocation` and `agent.idempotency_record` have no UPDATE/DELETE grants, plus row and TRUNCATE triggers (SQLSTATE `PSA01`) that also stop the superuser. Matches cannot be deleted and only move `active → unmatched`. Unmatching makes their allocations stop counting.
7. **Commit-time checks** (deferred constraint triggers, SQLSTATE 23514 with named constraints): `ledger_journal_balanced` (≥ 2 lines, sum 0) and `core_allocation_within_amount`.
8. **Optimistic concurrency** is enforced in the database: every update to a mutable row must bump `version` by one (`PSV01`), and handlers return `STALE_STATE { currentVersion }`.
9. **Writes** (`mutate()` in the api): idempotency record per `(org, key)` with a request hash (same key + different request → `IDEMPOTENCY_CONFLICT`), stored in the same transaction as the change; `dryRun` runs the real SQL, forces deferred constraints (`SET CONSTRAINTS ALL IMMEDIATE`), then rolls back; one `audit.event` per committed write, with `payerLabel` redacted.
10. **Authorization:** the org always comes from the Better Auth session. The role comes from `auth.member` on every call and is checked against `PERMISSIONS`, which the compiler forces to cover every contract procedure; an unmapped path throws (fail closed). Roles: viewer reads; clerk also creates/updates/annotates and may *request* destructive actions (those will need approval in M5); accountant adds `approval:approve` and `reversal:request`; admin/owner add member management.
11. **Better Auth clears the active organization** when a user tries to switch to an org they don't belong to (its `crud-org.mjs`). Calls then return FORBIDDEN until they pick again, and the web app shows an org picker. This is fail closed, so kept.
12. **Rate limiting** is Better Auth's database storage (works across replicas), keyed on `x-forwarded-for`. Verified that Caddy drops a client-supplied `X-Forwarded-For`: a forged address was not recorded.
13. **Hardening on the oRPC handlers:** CORS pinned to `PUBLIC_URL` with credentials, 1 MB body limit, prototype-pollution protection, GET CSRF protection on REST (RPC is POST-only), strict input objects (unknown keys → 400).
14. **Web security:** the static export's inline bootstrap scripts are allowed by **hash** (`scripts/web-csp.mjs` writes the CSP at build time), not `'unsafe-inline'`. Caddy uses `try_files {path} {path}index.html …` for trailing-slash routes. Sign-in does a full navigation so the session store isn't stale.
15. **Supply chain:** `.pnpmfile.mjs` strips Better Auth's optional peers on dev/framework tooling. Before this, pnpm bound them into its resolution and `pnpm deploy --prod` shipped vitest, drizzle-kit and three esbuild Go binaries (two critical Go stdlib CVEs) in the api image. `verify-images` and Trivy caught it. `allowBuilds` now denies `esbuild` and `sharp` explicitly.
16. **`make up` / `make smoke` build first, then `up`.** With `up --build` in one step, Compose kept the old `web` container after rebuilding its image.
17. **Snapshots:** the generated OpenAPI 3.2 document (including every agent-facing description) is committed at `apps/api/src/__snapshots__/openapi.json`; change it only with `make snapshots` and review the diff.
18. **Seed:** `make seed` (refuses with `NODE_ENV=production`, safe to re-run) creates Acme Rentals (owner, accountant, clerk, viewer) and Beta Academy (owner, clerk) with `@acme.test` / `@beta.test` emails, password `paysync-dev-password` (dev only; override with `SEED_PASSWORD`). The data includes a payer reference containing a prompt-injection string on purpose.

### Doc discrepancies and facts found

- **oRPC v2:** typed error definitions have no `status`; HTTP statuses come from `errorStatusMap` on the OpenAPI handler and generator (`ERROR_STATUS` in the contract keeps both in sync). `.route({...})` from §8.2 is `.meta(openapi({...}))` in v2. `ORPCError` has no `status` property. `onError` must be created inline so its types infer.
- **oRPC:** the server validates input and output against the contract by itself; the Request/Response Validation plugins are client-side (resolves the M0 note).
- **Better Auth 1.7:** the Drizzle adapter is `@better-auth/drizzle-adapter`; the CLI is the `auth` package; `getSession({ returnHeaders: true })` returns refreshed cookies, which we forward.
- **Drizzle 0.45:** `.for('update', { of: table })` renders a schema-qualified name, which Postgres rejects; we lock with a separate plain `SELECT … FOR UPDATE`.
- **Node `fetch`** drops `Sec-Fetch-*` request headers; the CSRF test uses `node:http`.

### [VERIFY] items settled in M1

- Drizzle covers checks, composite FKs, `pgSchema`, `uuidv7()` defaults and bigint; RLS, triggers and grants live in hand-written SQL, as §6 anticipated.
- Better Auth's oRPC integration needs no package: middleware calls `auth.api.getSession` with the request headers (`RequestHeadersHandlerPlugin`) and forwards `Set-Cookie` (`ResponseHeadersHandlerPlugin`).
- Better Auth rate limiting supports `storage: 'database'`.

### Next step

M2 (Daraja ingestion, sandbox): waiting for the owner's go-ahead.

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
| CI workflow | `actionlint 1.7.12`; first GitHub run [36191391152](https://github.com/all-black-493/paysync/actions/runs/36191391152) on `7e884a9` | clean; every step green (lint, typecheck, tests, image checks, smoke, Trivy, SBOM) in ~2.5 min |

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

