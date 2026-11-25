#!/bin/sh
# Production build pointed at the e2e API (NEXT_PUBLIC_* is baked at build time), then run Playwright.
set -e
NEXT_PUBLIC_API_BASE_URL=http://localhost:${E2E_API_PORT:-8120}/api/v1 pnpm exec next build
pnpm exec playwright test "$@"
