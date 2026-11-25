# syntax=docker/dockerfile:1.7
# Image for web-public (same layout as web.Dockerfile, which serves the other three Next.js apps). Build with compose named contexts `app` and `design-system`.
# They depend on ../design-system through `link:` deps, which a per-app build context cannot see, so compose passes two named
# contexts: `app` (the app repo) and `design-system`. Host node_modules / .next / .env* are never copied (tar excludes).
#   NEXT_PUBLIC_* values are inlined at build time: pass them as build args.
ARG NODE_IMAGE=node:24-alpine
FROM ${NODE_IMAGE} AS base
# busybox ash with pipefail: a failing `tar | tar` copy step fails the build instead of producing an empty tree (hadolint DL4006)
SHELL ["/bin/ash", "-eo", "pipefail", "-c"]
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 PNPM_HOME=/pnpm NEXT_TELEMETRY_DISABLED=1 CI=1
RUN corepack enable

FROM base AS build
WORKDIR /w
# Why: package.json has "@chilli/ui": "link:../design-system/packages/ui". With context = the app repo that path is outside the
# context, so a plain `docker build` fails. Named contexts (compose `additional_contexts`, or `--build-context` on the CLI) mount both
# repos; the Dockerfile lays them out as /w/design-system and /w/app so the relative link resolves. Apply the same two lines to any new app:
#   docker build -f compose/web.Dockerfile --build-context app=../web-marketing --build-context design-system=../design-system \
#     --build-arg NEXT_PUBLIC_API_BASE_URL=http://localhost:8200/api/v1 compose
# 1. design-system: install + build tokens and ui (dist/ is not committed)
RUN --mount=type=bind,from=design-system,target=/src \
    mkdir design-system && tar -C /src --exclude=node_modules --exclude=dist -cf - . | tar -C design-system -xf -
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    cd design-system && pnpm config set store-dir /pnpm/store && pnpm install --frozen-lockfile \
    && pnpm --filter @chilli/tokens build && pnpm --filter @chilli/ui build
# 2. the app, next to it so `link:../design-system/...` resolves
RUN --mount=type=bind,from=app,target=/src \
    mkdir app && tar -C /src --exclude=node_modules --exclude=.next --exclude='.env*' --exclude=e2e --exclude=test-results -cf - . | tar -C app -xf -
WORKDIR /w/app
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && pnpm install --frozen-lockfile
ARG NEXT_PUBLIC_PLATFORM_API_URL=""
ARG NEXT_PUBLIC_MARKETING_API_URL=""
ARG NEXT_PUBLIC_SITE_URL=""
ARG NEXT_PUBLIC_PLANS_API=""
ARG NEXT_PUBLIC_API_MOCK=""
ARG NEXT_PUBLIC_APP_SIGNIN_URL=""
ENV NEXT_PUBLIC_PLATFORM_API_URL=${NEXT_PUBLIC_PLATFORM_API_URL} NEXT_PUBLIC_MARKETING_API_URL=${NEXT_PUBLIC_MARKETING_API_URL} NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL} NEXT_PUBLIC_PLANS_API=${NEXT_PUBLIC_PLANS_API} NEXT_PUBLIC_API_MOCK=${NEXT_PUBLIC_API_MOCK} NEXT_PUBLIC_APP_SIGNIN_URL=${NEXT_PUBLIC_APP_SIGNIN_URL} NODE_ENV=production
# `next start` (not standalone): these apps link packages outside their folder, which standalone tracing handles poorly.
RUN pnpm exec next build

FROM base AS runtime
# next.config.ts recomputes the CSP (connect-src) at `next start`, so the runtime needs the same value as the build.
ARG NEXT_PUBLIC_PLATFORM_API_URL=""
ARG NEXT_PUBLIC_MARKETING_API_URL=""
ARG NEXT_PUBLIC_API_MOCK=""
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_PUBLIC_PLATFORM_API_URL=${NEXT_PUBLIC_PLATFORM_API_URL} NEXT_PUBLIC_MARKETING_API_URL=${NEXT_PUBLIC_MARKETING_API_URL} NEXT_PUBLIC_API_MOCK=${NEXT_PUBLIC_API_MOCK}
WORKDIR /w
COPY --from=build --chown=node:node /w /w
WORKDIR /w/app
USER node
EXPOSE 3000
# Run next directly with node: `pnpm exec` goes through corepack, which downloads pnpm into /home/node/.cache at EVERY start (fails
# on a read-only root filesystem and needs internet at runtime). Only /w/app/.next/cache needs to be writable (tmpfs).
CMD ["node", "node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
