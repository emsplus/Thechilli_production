/**
 * Route facts the shell needs before any page renders (server and client alike).
 * KNOWN_ROUTES must list every src/app/<route>/page.tsx (routes.test.ts checks it): any other path is a 404, shown inside
 * the shell when signed in and without it when signed out (never a redirect to /login, UI_REVIEW BA-22).
 */
export const KNOWN_ROUTES = [
  "/", "/accept-invite", "/account", "/ai", "/alerts", "/attendance", "/audit", "/cash", "/customers", "/end-of-day", "/forgot-password",
  "/kitchen", "/login", "/manage", "/modifiers", "/offers", "/orders", "/pos", "/procurement", "/register", "/reports",
  "/reservations", "/reset-password", "/staff-login", "/sync", "/system", "/today",
] as const;

const KNOWN = new Set<string>(KNOWN_ROUTES);
const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

/** Is `pathname` one of the app's pages (exact: every page is one segment deep)? */
export const isKnownRoute = (pathname: string) => KNOWN.has(norm(pathname));

/** The counter screens use the full width; every other page sits in the --content-max column (globals.css). */
const FULL_BLEED = ["/pos", "/kitchen"];
export const isFullBleed = (pathname: string) => FULL_BLEED.includes(norm(pathname));
