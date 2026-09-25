# syntax=docker/dockerfile:1.27@sha256:bde3983e9c939224420ddaf6b784cc30e09b035a4dea01f581230c50809f372e

ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ARG CADDY_IMAGE=caddy:2.11.4-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b

FROM ${NODE_IMAGE} AS base
ENV COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    pnpm_config_store_dir=/pnpm/store \
    CI=true
RUN corepack enable
WORKDIR /repo
# pnpm 12's shim downloads its native binary on first run; do it once here.
COPY package.json ./
RUN corepack install && pnpm --version

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=paysync-pnpm-store,target=/pnpm/store \
    pnpm fetch

FROM deps AS build
COPY . .
RUN --mount=type=cache,id=paysync-pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile
RUN pnpm build
RUN --mount=type=cache,id=paysync-pnpm-store,target=/pnpm/store \
    pnpm --filter @paysync/api --prod deploy /out/api && \
    pnpm --filter @paysync/worker --prod deploy /out/worker && \
    pnpm --filter @paysync/migrate --prod deploy /out/migrate

FROM build AS dev
ENV NODE_ENV=development
CMD ["pnpm", "test"]

FROM ${NODE_IMAGE} AS runtime
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
ENV NODE_ENV=production
WORKDIR /app
ARG VCS_REF=unknown
ARG VERSION=0.0.0-dev
LABEL org.opencontainers.image.source="https://github.com/all-black-493/paysync" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.licenses="UNLICENSED"
USER node

FROM runtime AS api
COPY --from=build --chown=root:root /out/api /app
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/main.js"]

FROM runtime AS worker
COPY --from=build --chown=root:root /out/worker /app
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3001/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/main.js"]

FROM runtime AS migrate
COPY --from=build --chown=root:root /out/migrate /app
CMD ["node", "--enable-source-maps", "dist/main.js"]

# Copying drops the binary's cap_net_bind_service xattr, which cap_drop ALL +
# no-new-privileges would otherwise refuse to exec. We listen on 8080 anyway.
FROM ${CADDY_IMAGE} AS caddy-base
RUN cp /usr/bin/caddy /tmp/caddy && mv /tmp/caddy /usr/bin/caddy
ENV XDG_CONFIG_HOME=/tmp/caddy/config \
    XDG_DATA_HOME=/tmp/caddy/data
USER 65534:65534
EXPOSE 8080
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]

FROM caddy-base AS web
COPY docker/web/Caddyfile /etc/caddy/Caddyfile
COPY apps/web/public /srv
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/"]

FROM caddy-base AS proxy
COPY docker/caddy/Caddyfile /etc/caddy/Caddyfile
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/_proxy/health"]
