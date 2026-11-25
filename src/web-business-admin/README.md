This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Voice ordering (hands-free)

Say **"Hey Zonov"**, then the order, for example: **"Hey Zonov, two butter naan"**. Both words are needed ("Zonov" alone does nothing); the
recogniser's usual spellings (zonov, zonoff, jonov, yonov, "zone off"...) are understood. Rules and tests: `src/lib/wakeWord.ts`, `e2e/wake-word.spec.ts`.

## Session and security headers

- **Session (BFF).** Sign-in, registration, token refresh and sign-out go through this app's own route handlers
  (`src/app/bff/auth/*`). They keep the 30-day refresh token in an httpOnly `SameSite=Strict` cookie (path `/bff/auth`) and
  give the page only the short-lived access token, which lives in memory. The readable `pos_session` cookie is a non-secret
  marker (session id, restaurant, user) so the PWA knows offline that it is signed in. Details: `src/lib/session-cookie.ts`.
- **Offline.** A sale queued offline is uploaded when the device is back online; if the access token expired meanwhile, the
  app first asks `/bff/auth/refresh` for a new one through the cookie.
- **Environment (server, run time):**
  - `POS_API_URL`: the pos-service base URL as seen from this server, e.g. `http://pos-service:8000/api/v1` in compose.
    Without it the build-time `NEXT_PUBLIC_API_BASE_URL` is used (or the same-origin `/api/v1` of the request).
  - `SESSION_COOKIE_SECURE`: `true`/`false` overrides the default (Secure everywhere except plain http on localhost; plain
    http on a real hostname is refused).
  - `TRUSTED_PROXY`: `true` when a reverse proxy in front sets `X-Forwarded-Proto` / `X-Forwarded-Host` and overwrites client values. The
    BFF then uses the forwarded host (else the Host header) for the loopback check; inside the container the request URL host is the bind
    address `0.0.0.0`, so without it plain http answered `500 insecure_transport` even on localhost. Default off (strict: URL host only).
    Plain http on a public hostname stays refused either way; `SESSION_COOKIE_SECURE` still overrides everything.
  - `HSTS` (`auto` default: sent only on https responses, `off` disables), `HSTS_MAX_AGE` (seconds, default 31536000),
    `HSTS_INCLUDE_SUBDOMAINS=true`.
  - pos-service should list this server in `FORWARDED_ALLOW_IPS`, so its per-IP limits see the browser's address
    (the BFF forwards `X-Forwarded-For`).
- **CSP.** `src/proxy.ts` sends a per-request nonce policy (no `'unsafe-inline'` scripts, `object-src 'none'`,
  `frame-ancestors 'none'`). Every page is therefore rendered per request (no `cacheComponents`). `e2e/csp.spec.ts` fails on
  any CSP violation on any route.
