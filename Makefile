SHELL := /bin/sh
.DEFAULT_GOAL := help

NODE_IMAGE := node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
COMPOSE    := docker compose
# Separate -p projects: -p beats COMPOSE_PROJECT_NAME, so `down -v` can never hit the dev stack.
SMOKE      := docker compose -f compose.yaml -p paysync-smoke
TEST       := docker compose -f compose.test.yaml -p paysync-test
TOOLS      := $(TEST) run --rm --build --no-deps test
TRIVY_IMAGE := aquasec/trivy:0.74.0@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969
IMAGE_TAG  ?= local
RUNTIME_IMAGES := api worker migrate web proxy
TRIVY      := docker run --rm -v /var/run/docker.sock:/var/run/docker.sock:ro \
              -v paysync-trivy-cache:/root/.cache/trivy -v "$$PWD":/work -w /work $(TRIVY_IMAGE)

.PHONY: help
help: ## List targets
	@grep -E '^[a-z][a-z-]*:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-18s %s\n", $$1, $$2}'

.env:
	cp .env.example .env

.PHONY: secrets
secrets: ## Generate missing dev secrets in secrets/ (never overwrites)
	@./scripts/dev-secrets.sh

.PHONY: bootstrap
bootstrap: .env secrets

.PHONY: up
up: bootstrap ## Build and start every service; waits until all are healthy
	$(COMPOSE) up --build --detach --wait

.PHONY: dev
dev: bootstrap ## Start with `compose watch` (rebuild on change)
	$(COMPOSE) up --build --watch

.PHONY: down
down: ## Stop the stack (keeps the database volume)
	$(COMPOSE) down --remove-orphans

.PHONY: logs
logs: ## Follow logs of every service
	$(COMPOSE) logs --follow --tail=100

.PHONY: ps
ps: ## Show service status
	$(COMPOSE) ps --all

.PHONY: build
build: bootstrap ## Build every image
	$(COMPOSE) build

.PHONY: migrate
migrate: bootstrap ## Run pending migrations against the dev database
	$(COMPOSE) up --build --no-log-prefix --abort-on-container-failure migrate

DRIZZLE_KIT := $(TEST) run --rm --build --no-deps --user "$$(id -u):$$(id -g)" -e HOME=/tmp \
               -v "$(CURDIR)/packages/db/migrations:/repo/packages/db/migrations" -w /repo/packages/db \
               test ./node_modules/.bin/drizzle-kit

.PHONY: db-generate
db-generate: secrets ## Generate a migration from the Drizzle schema diff: make db-generate NAME=add_x
	@test -n "$(NAME)" || { echo "usage: make db-generate NAME=snake_case_name" >&2; exit 1; }
	$(DRIZZLE_KIT) generate --name=$(NAME)

.PHONY: db-migration
db-migration: secrets ## Create an empty hand-written SQL migration: make db-migration NAME=add_x
	@test -n "$(NAME)" || { echo "usage: make db-migration NAME=snake_case_name" >&2; exit 1; }
	$(DRIZZLE_KIT) generate --custom --name=$(NAME)

.PHONY: auth-schema
auth-schema: secrets ## Regenerate the Better Auth Drizzle schema (then: make db-generate NAME=...)
	$(TEST) run --rm --build --no-deps --user "$$(id -u):$$(id -g)" -e HOME=/tmp \
	  -v "$(CURDIR)/packages/db/src/schema:/repo/packages/db/src/schema" -w /repo/packages/auth \
	  test ./node_modules/.bin/auth generate --config auth.cli.ts --adapter drizzle --dialect postgresql \
	  --output ../db/src/schema/auth.ts --yes
	./scripts/auth-schema-postprocess.sh

.PHONY: db-shell
db-shell: bootstrap ## psql into the dev database as the superuser
	$(COMPOSE) --profile tools run --rm psql

.PHONY: db-reset
db-reset: ## Delete the dev database volume and start fresh (refuses in production)
	@if [ "$${NODE_ENV:-}" = production ] || grep -qs '^NODE_ENV=production' .env; then \
	  echo "db-reset refused: NODE_ENV=production" >&2; exit 1; fi
	$(COMPOSE) down --volumes --remove-orphans
	$(MAKE) up

.PHONY: db-dump
db-dump: ## pg_dump -Fc of the dev database into backups/
	@mkdir -p backups
	$(COMPOSE) exec -T -u postgres db pg_dump -U postgres -Fc paysync > backups/paysync-$$(date -u +%Y%m%dT%H%M%SZ).dump
	@ls -1t backups | head -1

.PHONY: db-restore
db-restore: ## Restore FILE=backups/x.dump into the dev database (refuses in production)
	@test -n "$(FILE)" || { echo "usage: make db-restore FILE=backups/x.dump" >&2; exit 1; }
	@if [ "$${NODE_ENV:-}" = production ] || grep -qs '^NODE_ENV=production' .env; then \
	  echo "db-restore refused: NODE_ENV=production" >&2; exit 1; fi
	$(COMPOSE) exec -T -u postgres db pg_restore -U postgres -d paysync --clean --if-exists --single-transaction < $(FILE)

.PHONY: test
test: secrets ## Unit + integration tests against a throwaway Postgres 18
	@$(TEST) run --rm --build test pnpm test; code=$$?; \
	if [ $$code -ne 0 ]; then $(TEST) logs --no-log-prefix migrate; fi; \
	$(TEST) down --volumes --remove-orphans >/dev/null 2>&1; exit $$code

.PHONY: test-integration
test-integration: secrets ## Integration tests only
	@$(TEST) run --rm --build test pnpm test:integration; code=$$?; \
	if [ $$code -ne 0 ]; then $(TEST) logs --no-log-prefix migrate; fi; \
	$(TEST) down --volumes --remove-orphans >/dev/null 2>&1; exit $$code

.PHONY: test-unit
test-unit: secrets ## Unit tests only (no database)
	$(TOOLS) pnpm test:unit

.PHONY: snapshots
snapshots: secrets ## Rewrite reviewed snapshots (OpenAPI document) after an intended contract change
	$(TEST) run --rm --build --no-deps -e CI= \
	  -v "$(CURDIR)/apps/api/src/__snapshots__:/repo/apps/api/src/__snapshots__" \
	  test sh -c './node_modules/.bin/vitest run --project unit --update apps/api/src/contract.test.ts \
	    && chown -R '"$$(id -u):$$(id -g)"' apps/api/src/__snapshots__'

.PHONY: lint
lint: secrets ## ESLint
	$(TOOLS) pnpm lint

.PHONY: typecheck
typecheck: secrets ## TypeScript project build (strict)
	$(TOOLS) pnpm typecheck

.PHONY: check
check: lint typecheck test verify-images smoke scan ## Everything CI runs, locally

.PHONY: smoke
smoke: bootstrap ## Production-shaped stack in its own project: probe via proxy, then remove (needs `make down` first)
	$(SMOKE) up --build --detach --wait
	@code=0; \
	curl -fsS -o /dev/null http://127.0.0.1:$${PROXY_PORT:-8080}/ || code=1; \
	curl -fsS -o /dev/null http://127.0.0.1:$${PROXY_PORT:-8080}/_proxy/health || code=1; \
	test "$$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$${PROXY_PORT:-8080}/api/x)" = 404 || code=1; \
	$(SMOKE) down --volumes --remove-orphans; \
	if [ $$code -eq 0 ]; then echo "smoke ok"; else echo "smoke FAILED" >&2; fi; exit $$code

.PHONY: scan
scan: ## Trivy: fail on fixable CRITICAL vulnerabilities in runtime images
	@for svc in $(RUNTIME_IMAGES); do \
	  echo "== paysync/$$svc:$(IMAGE_TAG)"; \
	  $(TRIVY) image --quiet --scanners vuln --severity CRITICAL --ignore-unfixed --exit-code 1 \
	    paysync/$$svc:$(IMAGE_TAG) || exit 1; \
	done

.PHONY: sbom
sbom: ## CycloneDX SBOM for each runtime image into sbom/
	@mkdir -p sbom
	@for svc in $(RUNTIME_IMAGES); do \
	  $(TRIVY) image --quiet --format cyclonedx --output sbom/$$svc.cdx.json paysync/$$svc:$(IMAGE_TAG) || exit 1; \
	done; ls sbom

.PHONY: verify-images
verify-images: bootstrap ## Runtime images run as non-root and ship no dev dependencies
	@./scripts/verify-images.sh

.PHONY: lock
lock: ## Refresh pnpm-lock.yaml inside a container (after editing package.json)
	docker run --rm --user "$$(id -u):$$(id -g)" -e HOME=/tmp -e COREPACK_HOME=/tmp/corepack \
	  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 -v "$$PWD":/repo -w /repo $(NODE_IMAGE) \
	  sh -c 'corepack pnpm install --lockfile-only'

.PHONY: simulate
simulate: ## Replay Daraja fixtures against callback routes (M2)
	@echo "make simulate: not implemented yet (milestone M2)" >&2; exit 1

.PHONY: bench
bench: ## Matching + guard benchmarks (M10)
	@echo "make bench: not implemented yet (milestone M10)" >&2; exit 1

.PHONY: clean
clean: ## Stop everything and delete volumes and local images
	$(COMPOSE) down --volumes --remove-orphans --rmi local
	$(TEST) down --volumes --remove-orphans --rmi local
