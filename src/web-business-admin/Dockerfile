# syntax=docker/dockerfile:1.7
# Restaurant POS web (Next.js PWA). Build context: apps/web
#   docker build --build-arg NEXT_PUBLIC_API_BASE_URL=/api/v1 -t pos-web:local apps/web
# NEXT_PUBLIC_API_BASE_URL is inlined into the browser bundle at build time: changing it REQUIRES A REBUILD.
# The default "/api/v1" (same origin, behind the Caddy proxy) works for every domain, so one image serves staging
# and production.
ARG NODE_IMAGE=node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53

# ---- deps: exact lockfile install (pnpm version comes from package.json "packageManager" via corepack) ----------
FROM ${NODE_IMAGE} AS deps
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 PNPM_HOME=/pnpm NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && pnpm install --frozen-lockfile

# ---- build ------------------------------------------------------------------------------------------------------
FROM deps AS build
COPY . .
ARG NEXT_PUBLIC_API_BASE_URL=/api/v1
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL} NEXT_OUTPUT=standalone NODE_ENV=production
RUN test ! -e .env.local || (echo ".env.local must not be in the build context" && exit 1)
RUN pnpm exec next build

# ---- runtime: only the standalone server + static assets --------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# Code stays root-owned; the server may only write its cache dir (mount a tmpfs there when read_only).
RUN mkdir -p .next/cache && chown node:node .next/cache
ARG POS_VERSION=dev
ARG NEXT_PUBLIC_API_BASE_URL=/api/v1
LABEL org.opencontainers.image.title="pos-web" org.opencontainers.image.version="${POS_VERSION}" \
      pos.next_public_api_base_url="${NEXT_PUBLIC_API_BASE_URL}"
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/manifest.webmanifest').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server.js"]
