# syntax=docker/dockerfile:1.7
# Generic image for the three Next.js apps (web-business-admin, web-super-admin, web-marketing).
# They depend on ../design-system through `link:` deps, which a per-app build context cannot see, so compose passes two named
# contexts: `app` (the app repo) and `design-system`. Host node_modules / .next / .env* / .git are never copied (tar excludes).
#   NEXT_PUBLIC_* values are inlined at build time: pass them as build args.
#
# Security review 2026-10-31, finding 8: the runtime image used to be the whole build tree (sources, tests, dev dependencies,
# both repos' .git). It now holds only what `next start` needs, owned by root and read-only for the `node` user:
#   * standalone mode (the app's next.config honours NEXT_OUTPUT=standalone: web-business-admin, web-super-admin, web-marketing since fix/wm-standalone-image;
#     web-marketing's next.config.ts imports ./src, which the pruned layout below does not ship, so it must stay on this path):
#     .next/standalone (traced server + the production node_modules it needs), .next/static, public;
#   * pruned mode (an app without that switch; only for apps whose next.config.* imports nothing from ./src): .next (no cache), public, package.json, next.config.*,
#     and node_modules after `pnpm prune --prod` (no devDependencies), plus the built design-system packages the links point
#     at (dist + package.json, no sources).
# Either way the app lives in /w/app, the only writable path is /w/app/.next/cache (compose mounts a tmpfs there), and the
# container can run with read_only, cap_drop ALL and no-new-privileges.
ARG NODE_IMAGE=node:24-alpine
FROM ${NODE_IMAGE} AS base
# busybox ash with pipefail: a failing `tar | tar` copy step fails the build instead of producing an empty tree (hadolint DL4006)
SHELL ["/bin/ash", "-eo", "pipefail", "-c"]
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 PNPM_HOME=/pnpm NEXT_TELEMETRY_DISABLED=1 CI=1
RUN corepack enable

FROM base AS build
SHELL ["/bin/ash", "-eo", "pipefail", "-c"]
WORKDIR /w
# Why: package.json has "@chilli/ui": "link:../design-system/packages/ui". With context = the app repo that path is outside the
# context, so a plain `docker build` fails. Named contexts (compose `additional_contexts`, or `--build-context` on the CLI) mount both
# repos; the Dockerfile lays them out as /w/design-system and /w/app so the relative link resolves. Apply the same two lines to any new app:
#   docker build -f compose/web.Dockerfile --build-context app=../web-marketing --build-context design-system=../design-system \
#     --build-arg NEXT_PUBLIC_API_BASE_URL=http://localhost:8200/api/v1 compose
# 1. design-system: install + build tokens and ui (dist/ is not committed)
RUN --mount=type=bind,from=design-system,target=/src \
    mkdir design-system && tar -C /src --exclude=node_modules --exclude=dist --exclude=.git -cf - . | tar -C design-system -xf -
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    cd design-system && pnpm config set store-dir /pnpm/store && pnpm install --frozen-lockfile \
    && pnpm --filter @chilli/tokens build && pnpm --filter @chilli/ui build
# 2. the app, next to it so `link:../design-system/...` resolves
RUN --mount=type=bind,from=app,target=/src \
    mkdir app && tar -C /src --exclude=node_modules --exclude=.next --exclude='.env*' --exclude=e2e --exclude=.git \
      --exclude=test-results --exclude=playwright-report --exclude='*.jdk' -cf - . | tar -C app -xf -
WORKDIR /w/app
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && pnpm install --frozen-lockfile
ARG NEXT_PUBLIC_API_BASE_URL=""
ARG NEXT_PUBLIC_API_MOCK=""
# Other build-time URLs (empty = the app's default): business app sign-up form -> platform-core onboarding, its customer order
# link template; waiter app "Create an account" link. Without these the production images point at localhost / chilli.example.
ARG NEXT_PUBLIC_ONBOARDING_API_URL=""
ARG NEXT_PUBLIC_DELIVERY_ORDER_URL=""
ARG NEXT_PUBLIC_SIGNUP_URL=""
# Build heap cap (small or shared build hosts): e.g. --build-arg NODE_OPTIONS=--max-old-space-size=1536. Build stage only.
ARG NODE_OPTIONS=""
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL} NEXT_PUBLIC_API_MOCK=${NEXT_PUBLIC_API_MOCK} NODE_ENV=production \
    NEXT_PUBLIC_ONBOARDING_API_URL=${NEXT_PUBLIC_ONBOARDING_API_URL} NEXT_PUBLIC_DELIVERY_ORDER_URL=${NEXT_PUBLIC_DELIVERY_ORDER_URL} \
    NEXT_PUBLIC_SIGNUP_URL=${NEXT_PUBLIC_SIGNUP_URL} NODE_OPTIONS=${NODE_OPTIONS} NEXT_OUTPUT=standalone
RUN pnpm exec next build
# 3. the runtime tree, in /out/app (+ /out/design-system in pruned mode)
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store set -eu; mkdir -p /out; \
    if [ -d .next/standalone ]; then \
      srv="$(cd .next/standalone && find . -name server.js -not -path '*/node_modules/*' | awk '{print length, $0}' | sort -n | head -1 | cut -d' ' -f2)"; \
      [ -n "$srv" ] || { echo "standalone build without server.js" >&2; exit 1; }; \
      rel="$(dirname "$srv")"; \
      if [ "$rel" = "." ]; then cp -a .next/standalone /out/app; \
      else cp -a .next/standalone/. /out/ && [ "$rel" = "./app" ] || { echo "unexpected standalone layout: $rel" >&2; exit 1; }; fi; \
      mkdir -p /out/app/.next && cp -a .next/static /out/app/.next/static; \
      [ ! -d public ] || cp -a public /out/app/public; \
      echo standalone > /out/app/.run-mode; \
    else \
      pnpm prune --prod --config.store-dir=/pnpm/store; \
      mkdir -p /out/app; \
      cp -a .next node_modules package.json /out/app/; rm -rf /out/app/.next/cache; \
      for f in next.config.ts next.config.mjs next.config.js public; do [ ! -e "$f" ] || cp -a "$f" /out/app/; done; \
      for p in /w/design-system/packages/*; do \
        d="/out/design-system/packages/$(basename "$p")"; mkdir -p "$d"; cp -a "$p/package.json" "$d/"; \
        [ ! -d "$p/dist" ] || cp -a "$p/dist" "$d/"; \
      done; \
      echo pruned > /out/app/.run-mode; \
    fi; \
    find /out -name .git -prune -exec rm -rf {} +; \
    mkdir -p /out/app/.next/cache

FROM ${NODE_IMAGE} AS runtime
# next.config.ts recomputes the CSP (connect-src) at `next start`, so the runtime needs the same value as the build.
ARG NEXT_PUBLIC_API_BASE_URL=""
ARG NEXT_PUBLIC_API_MOCK=""
ARG NEXT_PUBLIC_ONBOARDING_API_URL=""
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL} NEXT_PUBLIC_API_MOCK=${NEXT_PUBLIC_API_MOCK} \
    NEXT_PUBLIC_ONBOARDING_API_URL=${NEXT_PUBLIC_ONBOARDING_API_URL}
# Root-owned, not writable by `node`; only the cache dir is (and compose puts a tmpfs on it).
COPY --from=build /out /w
RUN chown node:node /w/app/.next/cache
WORKDIR /w/app
USER node
EXPOSE 3000
CMD ["sh", "-c", "if [ \"$(cat .run-mode)\" = standalone ]; then exec node server.js; else exec node node_modules/next/dist/bin/next start -H 0.0.0.0 -p 3000; fi"]
