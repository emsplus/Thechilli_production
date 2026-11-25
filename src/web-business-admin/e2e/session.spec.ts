import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { API, bills, seed, signIn } from "./helpers";

/**
 * Session model: the 30-day refresh token is an httpOnly cookie only the BFF (/bff/auth/*) reads; the page keeps the
 * short-lived access token in memory and gets it from the BFF after every load.
 */

/** Signed-in POS. `access` lets a test start with a token the API will reject (as an expired one would be). */
async function openSignedIn(page: Page, s: { token: string; refresh: string }, access = s.token) {
  await signIn(page, access, s.refresh);
  await page.goto("/pos");
  await expect(page.getByRole("button", { name: /Latte/ }).first()).toBeVisible();
}

/** Same effect on the server as an expired JWT (signature check fails => 401), without waiting 30 minutes. */
const broken = (t: string) => `${t.slice(0, -4)}AAAA`;

const cookie = async (context: BrowserContext, name: string) => (await context.cookies()).find((c) => c.name === name);

/** BFF refresh answers that rotated the refresh token (they set a new pos_rt cookie). */
function countRotations(target: Page | BrowserContext) {
  const rotations: string[] = [];
  target.on("response", async (r) => {
    if (!r.url().endsWith("/bff/auth/refresh")) return;
    const set = (await r.headersArray()).filter((h) => h.name.toLowerCase() === "set-cookie").map((h) => h.value).join("\n");
    if (/pos_rt=[^;]+/.test(set) && !/pos_rt=;/.test(set)) rotations.push(r.url());
  });
  return rotations;
}

const queued = (page: Page) => page.evaluate(() => new Promise<number>((resolve, reject) => {
  const open = indexedDB.open("pos-offline");
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const req = open.result.transaction("queue").objectStore("queue").count();
    req.onsuccess = () => { resolve(req.result); open.result.close(); };
  };
}));

test("no token is readable by page scripts: refresh token httpOnly, access token in memory only", async ({ page, context, request }) => {
  const s = await seed(request);
  await openSignedIn(page, s);
  const rt = await cookie(context, "pos_rt");
  expect(rt).toMatchObject({ httpOnly: true, sameSite: "Strict", path: "/bff/auth" });
  const visible = await page.evaluate(() => ({ cookies: document.cookie, storage: JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) }));
  expect(visible.cookies).not.toContain("pos_rt");
  expect(visible.cookies).not.toContain("pos_at");
  expect(visible.cookies).toMatch(/pos_session=v1\./); // the non-secret marker
  for (const secret of [s.token, s.refresh]) {
    expect(visible.cookies).not.toContain(secret);
    expect(visible.storage).not.toContain(secret);
  }
  expect(visible.storage).not.toMatch(/eyJ[\w-]+\.eyJ/); // no JWT anywhere in web storage
});

test("expired access token mid-session is refreshed transparently and the action succeeds", async ({ page, context, request }) => {
  const s = await seed(request);
  const rotations = countRotations(page);
  await openSignedIn(page, s, broken(s.token)); // the page starts with a token the API rejects
  await page.getByRole("button", { name: /Latte/ }).first().click();
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.getByText("Order placed", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Send to kitchen/ }).click(); // uses the new token directly
  await expect(page.getByRole("button", { name: /Kitchen ticket #1 sent/ })).toBeVisible();
  await expect(page).toHaveURL(/\/pos$/, { timeout: 20_000 }); // never bounced to /login

  expect(rotations).toHaveLength(1);
  const rt = (await cookie(context, "pos_rt"))!.value;
  expect(rt).not.toBe(s.refresh); // rotated, still httpOnly in the cookie
  expect((await request.get(`${API}/orders`, { headers: s.auth })).status()).toBe(200);
  expect(await (await request.get(`${API}/orders`, { headers: s.auth })).json()).toHaveLength(1);
  // The rotated-out refresh token is dead: 409 inside the grace window, 401 (and session revoked) after it.
  expect([401, 409]).toContain((await request.post(`${API}/auth/refresh`, { data: { refresh_token: s.refresh } })).status());
});

test("parallel 401s in two tabs trigger exactly one rotation", async ({ page, context, request }) => {
  const s = await seed(request);
  await openSignedIn(page, s);
  const rotations = countRotations(context);
  await page.goto("/manage?tab=menu");
  const tab2 = await context.newPage(); // shares the cookies with the first tab
  await tab2.goto("/manage?tab=menu");
  await expect(tab2.getByRole("button", { name: "Edit Latte" })).toBeVisible();

  await signIn(context, broken(s.token), s.refresh); // same session, but its current access token is now rejected
  // Each Manage load fires several API calls at once (me, summary, categories, items ...); both tabs together = many concurrent 401s.
  await Promise.all([page.reload(), tab2.reload()]);
  for (const p of [page, tab2]) {
    await expect(p.getByRole("button", { name: "Edit Latte" })).toBeVisible();
    await expect(p).toHaveURL(/\/manage\?tab=menu$/);
  }
  await page.waitForTimeout(500);
  expect(rotations).toHaveLength(1); // single-flight in-tab (shared promise), across tabs (Web Locks) and in the BFF (reuse)
});

test("a page reload reuses the access token instead of rotating the refresh token", async ({ page, context, request }) => {
  const s = await seed(request);
  const rotations = countRotations(context);
  await openSignedIn(page, s);
  for (let i = 0; i < 3; i++) { await page.reload(); await expect(page.getByRole("button", { name: /Latte/ }).first()).toBeVisible(); }
  expect(rotations).toHaveLength(0);
  expect((await cookie(context, "pos_rt"))!.value).toBe(s.refresh);
});

test("sign out revokes the session at the API and clears the session cookies", async ({ page, context, request }) => {
  const s = await seed(request);
  await openSignedIn(page, s);
  const rt = (await cookie(context, "pos_rt"))!.value;
  const logout = page.waitForResponse((r) => r.url().endsWith("/bff/auth/logout"));
  await page.getByRole("button", { name: "Sign out" }).click();
  expect((await logout).status()).toBe(204);
  await expect(page).toHaveURL(/\/login/);
  for (const n of ["pos_rt", "pos_at", "pos_session"]) expect(await cookie(context, n)).toBeUndefined();
  expect((await request.post(`${API}/auth/refresh`, { data: { refresh_token: rt } })).status()).toBe(401);
  // and the app no longer counts as signed in
  await page.goto("/pos");
  await expect(page).toHaveURL(/\/login/);
});

test("a dead session goes to login but keeps the offline queue, which syncs after signing in", async ({ page, context, request }) => {
  const s = await seed(request);
  await openSignedIn(page, s);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await context.setOffline(true);
  await page.getByRole("button", { name: /Latte/ }).first().click();
  await page.getByRole("button", { name: /Place order/ }).click();
  await page.getByRole("button", { name: "Cash (offline)" }).click();
  await expect(page.getByTestId("pending-count")).toHaveText("3 pending");

  // The whole session dies while offline (e.g. revoked by a password change): the refresh cookie is gone and the API
  // rejects the in-memory access token. Offline, nothing is attempted.
  await context.clearCookies({ name: "pos_rt" });
  await context.clearCookies({ name: "pos_at" });
  await page.route(`${API}/**`, (r) => r.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ detail: "Invalid or expired token" }) }));
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  // The counter first says calmly what happened (audit C-13), then the cashier signs in.
  await expect(page.getByRole("dialog", { name: "Session expired, sign in again" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Sign in again" }).click();
  await expect(page).toHaveURL(/\/login/, { timeout: 30_000 });
  await page.unroute(`${API}/**`);
  expect(await queued(page)).toBe(3); // 401 never wipes the queue
  expect(await cookie(context, "pos_session")).toBeUndefined();

  await page.getByLabel("Email").fill(s.email);
  await page.getByLabel("Password").fill("supersecret123");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/pos$/, { timeout: 20_000 }); // the prompt sends the cashier back to the counter, not the role's home page
  await expect.poll(async () => Number((await bills(request, s))[0]?.balance_due ?? 1), { timeout: 30_000 }).toBe(0);
  expect(await bills(request, s)).toHaveLength(1); // exactly one invoice, never a duplicate
});

test("an operation queued offline is sent after the access token expired, renewed through the cookie when back online", async ({ page, context, request }) => {
  const s = await seed(request);
  await openSignedIn(page, s);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await context.setOffline(true);
  await page.getByRole("button", { name: /Latte/ }).first().click();
  await page.getByRole("button", { name: /Place order/ }).click();
  await page.getByRole("button", { name: "Cash (offline)" }).click();
  await expect(page.getByTestId("pending-count")).toHaveText("3 pending");
  // While offline the access token "expires": the API now rejects the one in memory and the BFF holds no usable copy.
  await signIn(context, broken(s.token), s.refresh);
  const rotations = countRotations(page);
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(async () => Number((await bills(request, s))[0]?.balance_due ?? 1), { timeout: 30_000 }).toBe(0);
  expect(await bills(request, s)).toHaveLength(1);
  expect(rotations.length).toBeGreaterThanOrEqual(1);
  await expect(page).toHaveURL(/\/pos$/);
});

test("legacy localStorage tokens from the previous version are moved into the cookie and deleted", async ({ page, context, request }) => {
  const s = await seed(request);
  await page.addInitScript(([t, r]) => { try { if (!sessionStorage.getItem("seeded")) { sessionStorage.setItem("seeded", "1"); localStorage.setItem("pos.token", t); localStorage.setItem("pos.refresh", r); } } catch {} }, [s.token, s.refresh]);
  await page.goto("/pos");
  await expect(page.getByRole("button", { name: /Latte/ }).first()).toBeVisible();
  expect(await page.evaluate(() => [localStorage.getItem("pos.token"), localStorage.getItem("pos.refresh")])).toEqual([null, null]);
  expect(await cookie(context, "pos_rt")).toMatchObject({ httpOnly: true });
  expect([401, 409]).toContain((await request.post(`${API}/auth/refresh`, { data: { refresh_token: s.refresh } })).status()); // rotated at once
});

test("menu options can be added, edited and removed on an existing item", async ({ page, request }) => {
  const s = await seed(request);
  await openSignedIn(page, s);
  await page.goto("/manage?tab=menu");
  await page.getByRole("button", { name: "Edit Latte" }).click();
  await page.getByRole("button", { name: "Add an option" }).click();
  await page.getByLabel("Option 1 name").fill("Large");
  await page.getByLabel("Option 1 extra price").fill("3.00");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Large +₹3.00")).toBeVisible();
  const item = async () => (await (await request.get(`${API}/menu/items`, { headers: s.auth })).json())[0];
  await expect.poll(async () => (await item()).variants.length, { timeout: 15_000 }).toBe(1); // the save may still be in flight
  const first = (await item()).variants;

  await page.getByRole("button", { name: "Edit Latte" }).click();
  await page.getByLabel("Option 1 extra price").fill("4.00");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Large +₹4.00")).toBeVisible();
  await expect.poll(async () => (await item()).variants, { timeout: 15_000 }).toEqual([{ ...first[0], price_delta: "4.00" }]); // same id, edited in place

  await page.getByRole("button", { name: "Edit Latte" }).click();
  await page.getByRole("button", { name: "Remove option 1" }).click();
  await expect(page.getByText(/Large will no longer be offered/)).toBeVisible();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText(/Large \+/)).toHaveCount(0);
  await expect.poll(async () => (await item()).variants, { timeout: 15_000 }).toEqual([]);
});
