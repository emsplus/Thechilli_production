import { expect, test, type Page } from "@playwright/test";
import { API, openAs, seedIn, type Seed } from "../helpers";
import { dumpQueue } from "../chaos/common";

// QA round 2 (docs/testing/FIX_ROUND2_COUNTER_REPORT.md): D25 expired session, D19 short viewports, D18 focus after Esc, D10 bill tabs,
// D06 discount messages, D13/D14/D15 menu item dialog, D20 guests, D26 two tabs, D27/D28/D29 roles. Run with playwright.round2.config.ts
// against a real pos-service (see there). Every test seeds its own restaurant.

let s: Seed;
test.beforeEach(async ({ request }) => { s = await seedIn(request); });

const dish = (page: Page) => page.getByRole("button", { name: /^Paneer Tikka,/ }).first();
async function addDish(page: Page) { await dish(page).click(); }

// ---------------------------------------------------------------------------------------------------------------- D25
for (const step of ["place", "kot", "bill"] as const) {
  test(`D25: session gone, ${step}: a clear 'Session expired, sign in again' prompt, no bare 'Not authenticated', the order survives sign-in`, async ({ page, context }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openAs(page, s.token, "/pos", s.refresh);
    await addDish(page);
    const panel = page.getByRole("complementary", { name: "Current order" });
    if (step !== "place") {
      await panel.getByRole("button", { name: "Place order" }).click();
      await expect(panel.getByRole("button", { name: /Send to kitchen/ })).toBeVisible();
    }
    if (step === "bill") { await panel.getByRole("button", { name: /Send to kitchen/ }).click(); await expect(panel.getByRole("button", { name: "Make bill" })).toBeVisible(); }
    // the session is gone: every auth cookie removed (another tab signed out, the refresh token was revoked ...)
    await context.clearCookies();
    // (the live bill preview may already have noticed the dead session and opened the prompt: then the button is behind it)
    await panel.getByRole("button", { name: step === "place" ? "Place order" : step === "kot" ? /Send to kitchen/ : "Make bill" }).click({ timeout: step === "bill" ? 4000 : 15_000 }).catch((e) => { if (step !== "bill") throw e; });
    const dlg = page.getByRole("dialog", { name: "Session expired, sign in again" });
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText("Your order is saved");
    await expect(page.getByText("Not authenticated")).toHaveCount(0);
    await dlg.getByRole("button", { name: "Sign in again" }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.getByLabel("Email").fill(s.email);
    await page.getByLabel("Password").fill("supersecret123");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/pos$/); // back on the counter, not the role's home page
    // the cart / the placed order is still there
    await expect(page.getByRole("complementary", { name: "Current order" })).toContainText("Paneer Tikka");
    if (step === "place") await expect(page.getByRole("complementary", { name: "Current order" }).getByRole("button", { name: "Place order" })).toBeVisible();
  });
}

// ---------------------------------------------------------------------------------------------------------------- D19
/** Height left for the dishes: from the lowest bar pinned to the top to the highest bar fixed at the bottom, page scrolled to the dish grid. */
async function freeBand(page: Page) {
  await page.getByTestId("menu-grid").evaluate((el) => el.scrollIntoView({ block: "start" }));
  return page.evaluate(() => {
    const pinned = [".vt-topbar", "[data-open-strip]"].map((sel) => document.querySelector(sel)).filter((e): e is Element => !!e && ["sticky", "fixed"].includes(getComputedStyle(e).position));
    const top = Math.max(0, ...pinned.map((e) => e.getBoundingClientRect().bottom));
    const bottoms = ["[data-cart-dock]", "nav[aria-label=Primary]"].map((sel) => document.querySelector(sel)).filter((e): e is Element => !!e).map((e) => e.getBoundingClientRect().top);
    const bottom = Math.min(innerHeight, ...bottoms);
    // The tablet-width layout (768 px and up) also boxes the grid in its own scroller: what it shows is the smaller of the two heights.
    const box = document.querySelector("[data-testid=menu-grid]")!.parentElement!.clientHeight;
    return { band: Math.round(Math.min(bottom - top, box)), top: Math.round(top), bottom: Math.round(bottom), box, vh: innerHeight, hscroll: document.documentElement.scrollWidth > innerWidth };
  });
}
for (const [w, h] of [[667, 375], [844, 390], [640, 400], [568, 320]] as const) {
  test(`D19: ${w}x${h} (landscape phone / 200% zoom) keeps a usable dish area between the bars`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await openAs(page, s.token, "/pos", s.refresh);
    await expect(dish(page)).toBeVisible();
    await addDish(page); // the cart bar shows (< 768 px wide)
    await page.waitForTimeout(600);
    const m = await freeBand(page);
    console.log(`D19 ${w}x${h}`, JSON.stringify(m));
    expect(m.hscroll).toBe(false);
    expect(m.band, JSON.stringify(m)).toBeGreaterThanOrEqual(Math.round(h * 0.6)); // before the fix ~90-120 px at 375-400 px tall (about 25-30 %)
    // a dish card's Add button can be reached: it sits between the bars once scrolled
    await dish(page).scrollIntoViewIfNeeded();
    const b = await dish(page).boundingBox();
    expect(b).not.toBeNull();
  });
}
test("D19: a tall phone and a desktop are not changed (bars keep their size, top bar stays pinned)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAs(page, s.token, "/pos", s.refresh);
  await expect(dish(page)).toBeVisible();
  const tb = await page.evaluate(() => ({ pos: getComputedStyle(document.querySelector(".vt-topbar")!).position, h: document.querySelector(".vt-topbar")!.getBoundingClientRect().height, tab: document.querySelector("nav[aria-label=Primary]")!.getBoundingClientRect().height }));
  expect(tb.pos).toBe("sticky"); expect(tb.h).toBe(64); expect(tb.tab).toBe(70);
});

// ---------------------------------------------------------------------------------------------------------------- D18
test("D18: after Esc the Discount dialog gives focus back to 'Add discount' (and Cancel does the same)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openAs(page, s.token, "/pos", s.refresh);
  await addDish(page);
  const panel = page.getByRole("complementary", { name: "Current order" });
  const trigger = panel.getByRole("button", { name: /Add discount/ });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Add discount" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Add discount" })).toHaveCount(0);
  await expect(trigger).toBeFocused();
  // mouse: click opens, Cancel closes
  await trigger.click();
  await page.getByRole("dialog", { name: "Add discount" }).getByRole("button", { name: "Cancel" }).click();
  await expect(trigger).toBeFocused();
});

// ---------------------------------------------------------------------------------------------------------------- D10
test("D10: with 8 bills open the last tab's close button is clear of the faded edge and the New button", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openAs(page, s.token, "/pos", s.refresh);
  await expect(dish(page)).toBeVisible();
  const add = page.getByRole("button", { name: /^New: / });
  for (let i = 0; i < 7; i++) { await add.click(); await page.waitForTimeout(150); }
  const scroller = page.getByTestId("open-orders-scroll");
  await scroller.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  await page.waitForTimeout(500);
  const m = await page.evaluate(() => {
    const sc = document.querySelector("[data-testid=open-orders-scroll]")!.getBoundingClientRect();
    const closes = [...document.querySelectorAll("button[aria-label^='Close ']")].map((e) => e.getBoundingClientRect());
    const last = closes[closes.length - 1];
    const nw = [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label")?.startsWith("New:"))!.getBoundingClientRect();
    return { count: closes.length, closeRight: last.right, scrollRight: sc.right, newLeft: nw.left, fade: 16 };
  });
  expect(m.count).toBe(8);
  expect(m.closeRight, JSON.stringify(m)).toBeLessThanOrEqual(m.scrollRight - m.fade); // outside the 16 px mask that fades the strip's edge
  expect(m.closeRight, JSON.stringify(m)).toBeLessThanOrEqual(m.newLeft);
});

// ---------------------------------------------------------------------------------------------------------------- D06
test("D06: discount messages match the mistake; Apply is disabled for empty and whitespace alike", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openAs(page, s.token, "/pos", s.refresh);
  await addDish(page);
  await page.getByRole("complementary", { name: "Current order" }).getByRole("button", { name: /Add discount/ }).click();
  const dlg = page.getByRole("dialog", { name: "Add discount" });
  const apply = dlg.getByRole("button", { name: "Apply discount" });
  const input = dlg.getByLabel("Percent off");
  await expect(apply).toBeDisabled(); // empty
  await input.fill("  ");
  await expect(apply).toBeDisabled(); // whitespace: same
  await expect(dlg).toContainText("Enter the discount");
  await input.fill("1e1");
  await expect(dlg).toContainText("Use digits only");
  await expect(dlg).not.toContainText("greater than zero");
  await input.fill("10.555");
  await expect(dlg).toContainText("at most 2 decimal places");
  await input.fill("0");
  await expect(dlg).toContainText("greater than zero");
  await input.fill("10");
  await expect(apply).toBeEnabled();
});

// ---------------------------------------------------------------------------------------------------------------- D13 / D14 / D15
async function openItemDialog(page: Page) {
  await openAs(page, s.token, "/manage?tab=menu", s.refresh);
  await page.getByRole("button", { name: /Add item|Add dish|New item/i }).first().click();
  const dlg = page.getByRole("dialog");
  await expect(dlg).toBeVisible();
  return dlg;
}
test("D13: a 409 from the server (duplicate dish name) shows its message inline under Name", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const msg = 'A dish named "Paneer Tikka" already exists. Choose another name.';
  await page.route("**/api/v1/menu/items", async (route) => {
    if (route.request().method() === "POST") return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ detail: msg, error: { code: "duplicate_item_name", message: msg, details: { item_id: "x" } } }) });
    return route.continue();
  });
  const dlg = await openItemDialog(page);
  await dlg.getByLabel(/^Name/).fill("Paneer Tikka");
  await dlg.getByLabel(/^Price/).fill("250");
  await dlg.getByRole("button", { name: /^Add item|Add dish|Save/i }).last().click();
  await expect(dlg.getByText(msg)).toBeVisible();
  await expect(dlg.getByLabel(/^Name/)).toHaveAttribute("aria-invalid", "true");
});
test("D14: price 0 asks once before saving a free dish", async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  let posts = 0;
  await page.route("**/api/v1/menu/items", async (route) => { if (route.request().method() === "POST") posts++; return route.continue(); });
  const dlg = await openItemDialog(page);
  await dlg.getByLabel(/^Name/).fill("Free Papad");
  await dlg.getByLabel(/^Price/).fill("0");
  await dlg.getByRole("button", { name: /^Add item|Add dish|Save/i }).last().click();
  const ask = page.getByRole("dialog", { name: "Save this dish at 0?" });
  await expect(ask).toBeVisible();
  expect(posts).toBe(0);
  await ask.getByRole("button", { name: "Change the price" }).click();
  expect(posts).toBe(0);
  await dlg.getByRole("button", { name: /^Add item|Add dish|Save/i }).last().click();
  await page.getByRole("dialog", { name: "Save this dish at 0?" }).getByRole("button", { name: "Save as free" }).click();
  await expect.poll(() => posts).toBe(1);
  await expect.poll(async () => ((await (await request.get(`${API}/menu/items`, { headers: s.auth })).json()) as { name: string }[]).some((i) => i.name === "Free Papad")).toBe(true);
});
test("D15: a price with more than 10 digits is refused inline, in plain words, with no request sent", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  let posts = 0;
  await page.route("**/api/v1/menu/items", async (route) => { if (route.request().method() === "POST") posts++; return route.continue(); });
  const dlg = await openItemDialog(page);
  await dlg.getByLabel(/^Name/).fill("Gold Thali");
  await dlg.getByLabel(/^Price/).fill("12345678901");
  await dlg.getByRole("button", { name: /^Add item|Add dish|Save/i }).last().click();
  await expect(dlg).toContainText("up to 10 digits");
  await expect(page.getByText(/Decimal input|pydantic/i)).toHaveCount(0);
  expect(posts).toBe(0);
});

// ---------------------------------------------------------------------------------------------------------------- D20
test("D20: Guests refuses '2.5' and '-3' instead of turning them into 25 and 3", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openAs(page, s.token, "/reservations", s.refresh);
  await page.getByRole("button", { name: /New reservation|Add reservation|Book/i }).first().click();
  const dlg = page.getByRole("dialog", { name: "New reservation" });
  const guests = dlg.getByLabel("Guests");
  await guests.fill("2.5");
  await expect(guests).toHaveValue("2.5"); // not silently changed
  await expect(dlg).toContainText("whole number");
  await guests.fill("-3");
  await expect(guests).toHaveValue("-3");
  await expect(dlg).toContainText("whole number");
  await guests.fill("4");
  await expect(dlg).not.toContainText("whole number");
});

// ---------------------------------------------------------------------------------------------------------------- D26
test("D26: a second tab that sends to the kitchen after the first already did flips to 'in the kitchen' at once", async ({ page, context }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openAs(page, s.token, "/pos", s.refresh);
  await addDish(page);
  const panelA = page.getByRole("complementary", { name: "Current order" });
  await panelA.getByRole("button", { name: "Place order" }).click();
  await expect(panelA.getByRole("button", { name: /Send to kitchen/ })).toBeVisible();
  const b = await context.newPage();
  await b.setViewportSize({ width: 1280, height: 800 });
  await b.goto("/pos");
  const panelB = b.getByRole("complementary", { name: "Current order" });
  await expect(panelB.getByRole("button", { name: /Send to kitchen/ })).toBeVisible();
  await panelA.getByRole("button", { name: /Send to kitchen/ }).click();
  await expect(panelA.getByRole("button", { name: "Make bill" })).toBeVisible();
  // tab B has not heard yet: its button is still there; pressing it gets the server's 409
  await panelB.getByRole("button", { name: /Send to kitchen/ }).click();
  await expect(panelB.getByRole("button", { name: "Make bill" })).toBeVisible({ timeout: 3000 });
  await expect(panelB.getByRole("button", { name: /Send to kitchen/ })).toHaveCount(0);
});

// ---------------------------------------------------------------------------------------------------------------- D27 / D28 / D29
/** Answers GET /auth/me as another role (the server's own checks stay real). */
async function actAs(page: Page, role: string, perms?: string[]) {
  await page.route("**/api/v1/auth/me", async (route) => {
    const r = await route.fetch();
    const j = await r.json();
    await route.fulfill({ response: r, json: { ...j, role, ...(perms ? { permissions: perms } : {}) } });
  });
}
test("D27: a cashier's page load does not call /reviews/summary (no 403 per page); the owner's still does", async ({ page }) => {
  const calls: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/reviews/summary")) calls.push(r.url()); });
  await actAs(page, "cashier", ["orders.create", "bills.finalize", "payments.create", "kot.view"]);
  await openAs(page, s.token, "/pos", s.refresh);
  await expect(dish(page)).toBeVisible();
  await page.waitForTimeout(2500);
  expect(calls).toEqual([]);
  const owner = await page.context().newPage();
  const ownerCalls: string[] = [];
  owner.on("request", (r) => { if (r.url().includes("/reviews/summary")) ownerCalls.push(r.url()); });
  await owner.goto("/pos");
  await expect(owner.getByRole("button", { name: /^Paneer Tikka,/ }).first()).toBeVisible();
  await owner.waitForTimeout(2500);
  expect(ownerCalls.length).toBeGreaterThan(0);
});
test("D28: the kitchen role opening /pos by URL sees a lock panel with a way to the Kitchen, not the counter", async ({ page }) => {
  await actAs(page, "kitchen");
  await openAs(page, s.token, "/pos", s.refresh);
  await expect(page.getByText("This screen is for the counter")).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to Kitchen" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Place order" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Paneer Tikka,/ })).toHaveCount(0);
});
test("D29: a cashier refused by Reports sees the lock panel without End of day / Refresh above it", async ({ page }) => {
  await page.route("**/api/v1/reports/**", (r) => r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ detail: "Missing permission: reports.view" }) }));
  await openAs(page, s.token, "/reports", s.refresh);
  await expect(page.getByText("Ask the owner or manager")).toBeVisible();
  const main = page.getByRole("main");
  await expect(main.getByRole("link", { name: /End of day \(Z report\)/ })).toHaveCount(0);
  await expect(main.getByRole("button", { name: "Refresh" })).toHaveCount(0);
});

test("D13: a 409 that is not about the name stays a toast, not a message under Name", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const msg = "This item was changed on another device. Reload and try again.";
  await page.route("**/api/v1/menu/items", async (route) => {
    if (route.request().method() === "POST") return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ detail: msg, error: { code: "conflict", message: msg } }) });
    return route.continue();
  });
  const dlg = await openItemDialog(page);
  await dlg.getByLabel(/^Name/).fill("Paneer Tikka");
  await dlg.getByLabel(/^Price/).fill("250");
  await dlg.getByRole("button", { name: /^Add item|Add dish|Save/i }).last().click();
  await expect(page.getByText(msg)).toBeVisible();
  await expect(dlg.getByLabel(/^Name/)).not.toHaveAttribute("aria-invalid", "true");
});

// ---------------------------------------------------------------------------------------------------------------- H1 (client part)
/** A device whose clock is off by `offsetMs`: Date / Date.now() shifted, timers keep running. */
const skewDeviceClock = (page: Page, offsetMs: number) => page.addInitScript((off: number) => {
  const D = Date;
  class Skewed extends D { constructor(...a: unknown[]) { if (a.length === 0) super(D.now() + off); else super(...(a as [number])); } static now() { return D.now() + off; } }
  (window as unknown as { Date: unknown }).Date = Skewed;
}, offsetMs);

test("H1: every sync batch carries client_sent_at = the raw device clock at the send, and client_created_at per op", async ({ page, context }) => {
  const SKEW = -45 * 60_000; // a slow tablet: 45 minutes behind
  await skewDeviceClock(page, SKEW);
  await page.setViewportSize({ width: 1280, height: 800 });
  await openAs(page, s.token, "/pos", s.refresh);
  await expect(dish(page)).toBeVisible();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await context.setOffline(true);
  await addDish(page);
  await page.getByRole("complementary", { name: "Current order" }).getByRole("button", { name: "Place order" }).click();
  await expect.poll(async () => (await dumpQueue(page)).length).toBeGreaterThan(0);
  const bodies: { operations: { client_created_at?: string }[]; client_sent_at?: string }[] = [];
  page.on("request", (r) => { if (r.url().endsWith("/sync/operations") && r.method() === "POST") bodies.push(r.postDataJSON()); });
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => bodies.length, { timeout: 30_000 }).toBeGreaterThan(0);
  const b = bodies[0];
  expect(typeof b.client_sent_at).toBe("string");
  expect(b.client_sent_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  const deviceNow = Date.now() + SKEW;
  expect(Math.abs(Date.parse(b.client_sent_at!) - deviceNow)).toBeLessThan(60_000); // the skewed device clock, not corrected
  expect(b.operations.every((o) => typeof o.client_created_at === "string")).toBe(true);
});

// ---------------------------------------------------------------------------------------------------------------- L1 (queue)
test("L1: one operation the server refuses is marked failed (still listed); the other offline orders sync", async ({ page, context, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openAs(page, s.token, "/pos", s.refresh);
  await expect(dish(page)).toBeVisible();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await context.setOffline(true);
  const panel = page.getByRole("complementary", { name: "Current order" });
  for (let i = 0; i < 2; i++) {
    if (i > 0) await page.getByRole("button", { name: /^New: / }).click();
    await addDish(page);
    await panel.getByRole("button", { name: "Place order" }).click();
    await expect.poll(async () => (await dumpQueue(page)).length).toBe(i + 1);
  }
  const q = await dumpQueue(page);
  const poisonRef = q[0].ref as string;
  // the server rejects any batch that holds the first order's create_order, with a 422 (e.g. a value it will never accept)
  await page.route("**/api/v1/sync/operations", async (route) => {
    const body = route.request().postDataJSON() as { operations: { op: { order?: { client_uuid: string } } }[] };
    if (body.operations.some((o) => o.op.order?.client_uuid === poisonRef))
      return route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ detail: "Request validation failed", error: { code: "validation_error", message: "Request validation failed" } }) });
    return route.continue();
  });
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(async () => (await dumpQueue(page)).map((o) => `${o.ref === poisonRef ? "bad" : "good"}:${o.status}`).sort().join(","), { timeout: 40_000 }).toBe("bad:failed,good:synced");
  const failed = (await dumpQueue(page)).find((o) => o.ref === poisonRef)!;
  expect(failed.error).toMatch(/refused/);
  expect((await (await request.get(`${API}/orders`, { headers: s.auth })).json()).length).toBe(1); // the good order reached the server
  // still visible for the owner on the Sync screen, with a way to retry or discard
  await page.goto("/sync");
  await expect(page.getByText(/The server refused this step/).first()).toBeVisible();
});

// ---------------------------------------------------------------------------------------------------------------- double tap on an offline Place order
test("a double tap on Place order offline queues the order once", async ({ page, context }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openAs(page, s.token, "/pos", s.refresh);
  await expect(dish(page)).toBeVisible();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await context.setOffline(true);
  await addDish(page);
  const btn = page.getByRole("complementary", { name: "Current order" }).getByRole("button", { name: "Place order" });
  await btn.evaluate((el) => { (el as HTMLButtonElement).click(); (el as HTMLButtonElement).click(); (el as HTMLButtonElement).click(); }); // three taps in one task: before the button can re-render as disabled
  await expect.poll(async () => (await dumpQueue(page)).length).toBeGreaterThan(0);
  await page.waitForTimeout(800);
  expect((await dumpQueue(page)).filter((o) => o.type === "create_order")).toHaveLength(1);
});
