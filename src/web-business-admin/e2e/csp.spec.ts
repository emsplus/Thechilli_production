import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { KNOWN_ROUTES } from "../src/components/shell/routes";
import { seed, signIn, type Seed } from "./helpers";

/**
 * Security headers on a production build: nonce CSP without 'unsafe-inline' scripts, no CSP violation on any route
 * (signed out and signed in, light only), and voice / PWA still working under it.
 */

const PUBLIC = ["/login", "/register", "/forgot-password", "/reset-password"];
const MANAGE_TABS = ["overview", "menu", "tables", "customers", "recipes", "inventory", "suppliers", "staff", "restaurant", "printers", "outlets", "system"].map((t) => `/manage?tab=${t}`);
const APP = [...KNOWN_ROUTES.filter((r) => !PUBLIC.includes(r)), ...MANAGE_TABS];

/** Collects every CSP violation the page reports (DOM event, so nothing depends on console wording) plus console errors naming CSP. */
export async function watchCsp(page: Page) {
  const seen: string[] = [];
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      w.__csp.push(`${e.violatedDirective} blocked ${e.blockedURI || "inline"} at ${e.sourceFile}:${e.lineNumber} sample=${e.sample}`);
    });
  });
  page.on("console", (m) => { if (/Content Security Policy|Refused to (execute|load|apply|connect|frame)/i.test(m.text())) seen.push(`console: ${m.text().slice(0, 300)}`); });
  return async () => [...seen, ...(await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []).catch(() => []))];
}

let s: Seed;
test.beforeAll(async ({ request }) => { s = await seed(request); });

test("page headers: nonce CSP, no inline scripts allowed, framing/objects/base/forms locked, no HSTS on plain http", async ({ page }) => {
  const res = await page.goto("/login");
  const h = res!.headers();
  const csp = h["content-security-policy"];
  expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  for (const d of ["object-src 'none'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'"]) expect(csp).toContain(d);
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["x-frame-options"]).toBe("DENY");
  expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(h["permissions-policy"]).toContain("microphone=(self)");
  expect(h["strict-transport-security"]).toBeUndefined(); // only behind https
  // a fresh nonce per response, and every <script> on the page carries it
  const nonce = csp.match(/'nonce-([^']+)'/)![1];
  const again = (await page.request.get("/login")).headers()["content-security-policy"];
  expect(again).not.toContain(nonce);
  const scripts = await page.evaluate(() => [...document.scripts].map((x) => x.nonce));
  expect(scripts.length).toBeGreaterThan(0);
  expect(scripts.every((n) => n === nonce)).toBe(true);
});

test("HSTS is sent when the proxy says the page was served over https", async ({ request }) => {
  const r = await request.get("/login", { headers: { "x-forwarded-proto": "https" } });
  expect(r.headers()["strict-transport-security"]).toMatch(/^max-age=\d+/);
  expect(r.headers()["content-security-policy"]).toContain("upgrade-insecure-requests");
});

test("injected markup cannot run script: inline handlers and javascript: URLs are blocked", async ({ page }) => {
  const report = await watchCsp(page);
  await page.goto("/login");
  await page.evaluate(() => {
    const box = document.createElement("div");
    box.innerHTML = '<img src="data:," onerror="window.__pwned=1"><a id="js" href="javascript:window.__pwned=2">x</a>';
    document.body.appendChild(box);
    (document.getElementById("js") as HTMLAnchorElement).click();
  });
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  expect((await report()).join("\n")).toMatch(/script-src/);
});

for (const scheme of ["light"] as const) {
  test(`no CSP violations on any route (${scheme})`, async ({ page }) => {
    test.setTimeout(240_000);
    await page.emulateMedia({ colorScheme: scheme });
    const report = await watchCsp(page);
    const bad: string[] = [];
    for (const route of PUBLIC) {
      await page.goto(route, { waitUntil: "load" });
      await page.waitForTimeout(400);
      bad.push(...(await report()).map((v) => `${route}: ${v}`));
    }
    await signIn(page, s.token, s.refresh);
    for (const route of APP) {
      await page.goto(route, { waitUntil: "load" });
      await page.waitForTimeout(800); // data, toasts and lazy chunks settle
      bad.push(...(await report()).map((v) => `${route}: ${v}`));
    }
    expect([...new Set(bad)]).toEqual([]);
  });
}

test("dialogs (Radix scroll lock injects a <style>) open without a CSP violation", async ({ page }) => {
  const report = await watchCsp(page);
  await page.goto("/login");
  await page.getByRole("button", { name: "Forgot password?" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.waitForTimeout(300);
  expect(await report()).toEqual([]);
  // the scroll lock's style really applied (it carries the page nonce)
  expect(await page.evaluate(() => [...document.querySelectorAll("style")].some((s) => s.nonce && /overflow:\s*hidden/.test(s.textContent ?? "")))).toBe(true);
});

test("login with the CSP: axe clean and the sign-in works end to end", async ({ page }) => {
  const report = await watchCsp(page);
  await page.goto("/login");
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
  await page.getByLabel("Email").fill(s.email);
  await page.getByLabel("Password").fill("supersecret123");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/manage$/, { timeout: 20_000 });
  expect(await report()).toEqual([]);
});

test("the service worker installs and controls the app under the CSP", async ({ page, context }) => {
  const report = await watchCsp(page);
  await signIn(page, s.token, s.refresh);
  await page.goto("/pos");
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  // offline navigation is served from the cache, with the cached page's own (matching) nonce
  await context.setOffline(true);
  await page.goto("/orders").catch(() => undefined);
  await page.goto("/pos");
  await expect(page.getByRole("button", { name: /Latte/ }).first()).toBeVisible();
  await context.setOffline(false);
  expect(await report()).toEqual([]);
});
