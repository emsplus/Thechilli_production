import AxeBuilder from "@axe-core/playwright";
import { expect, test, type ConsoleMessage, type Page, type Route } from "@playwright/test";
import { signIn } from "./helpers";

// Manage > Delivery > "Your ordering link" against a fake pos-service (every /api/v1 call is mocked; no live stack).
// Contract: pos-service docs/DELIVERY_API.md "Public ordering link". Run with playwright.mocked.config.ts (see there).
// SHOT_DIR=<dir> also writes the screenshots at 390 and 1280, light and dark.

const BASE = "https://order.thechilli.ai/r/";
const TOKEN_SECRET = "svc-token-DO-NOT-LEAK-12345";
const UNAVAILABLE = "We could not reach the online ordering service, so the link was not changed. Your other settings were saved. Please try again in a minute.";
const NOT_CONNECTED = "The online ordering link is not connected yet, so it could not be changed. Your other settings were saved. Please try again in a minute or contact support.";

interface Fake {
  enabled: boolean; tokenSet: boolean; slug: string; n: number; color: string | null; secretPending: boolean;
  /** "ok" | "down" (502 could not reach) | "not_connected" (502) */
  mode: "ok" | "down" | "not_connected";
  /** GET answers "enabled" but without a URL (delivery service says off) */
  noUrl: boolean;
  puts: Record<string, unknown>[];
}
const fresh = (over: Partial<Fake> = {}): Fake => ({ enabled: false, tokenSet: false, slug: "k3f9x2qd7mwa", n: 0, color: null, secretPending: false, mode: "ok", noUrl: false, puts: [], ...over });

const settingsOf = (f: Fake) => ({
  enabled: true, accept_before_kot: false, delivery_fee: "0.00", free_delivery_above: null, min_order: "150.00", radius_km: null, hours: null,
  webhook_url: null, has_webhook_secret: false, public_order_enabled: f.enabled, public_order_url: f.enabled && !f.noUrl ? `${BASE}${f.slug}` : null, public_order_token_set: f.tokenSet,
});

const ME = (perms: string[]) => ({ id: "u1", email: "owner@example.in", full_name: "Owner", role: "owner", is_active: true, permissions: perms,
  business_types: ["cloud_kitchen"], capabilities: { delivery_orders: true, dine_in: false, tables: false, reservations: false }, restaurant_name: "Chilli Test Dhaba" });
const PERMS = ["delivery.manage", "delivery.accept", "settings.owner"];

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const fakeJwt = () => `${b64({ alg: "none" })}.${b64({ sub: "u1", rid: "r1", exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;

/** pos-service, as far as this screen uses it. */
async function mockApi(page: Page, f: Fake, perms = PERMS) {
  await page.route("**/api/v1/**", async (route: Route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace(/^.*\/api\/v1/, "");
    const json = (status: number, body: unknown) => route.fulfill({ status, json: body });
    if (path === "/auth/me") return json(200, ME(perms));
    if (path === "/delivery/admin/orders") return json(200, []);
    if (path === "/delivery/settings" && req.method() === "GET") return json(200, settingsOf(f));
    if (path === "/delivery/settings" && req.method() === "PUT") {
      const b = req.postDataJSON() as Record<string, unknown>;
      f.puts.push(b);
      const touchesLink = b.public_order_enabled !== undefined || b.rotate_public_order_link || b.public_order_brand_color !== undefined;
      if (b.public_order_service_token !== undefined) f.tokenSet = b.public_order_service_token !== "";
      if (touchesLink && f.mode !== "ok") {
        const detail = f.mode === "down" ? UNAVAILABLE : NOT_CONNECTED;
        const settings = { ...settingsOf(f), ...(f.secretPending ? { webhook_secret: "whsec_one_time_secret" } : {}) };
        return json(502, { code: "delivery_service_unavailable", error: { code: "delivery_service_unavailable", message: detail }, detail, settings });
      }
      const off = { code: "public_order_link_off", detail: "Turn the online ordering link on first, then you can make a new link or change its colour." };
      if (b.public_order_enabled !== undefined) f.enabled = b.public_order_enabled === true;
      else if ((b.rotate_public_order_link || b.public_order_brand_color !== undefined) && !f.enabled) return json(409, off);
      if (typeof b.public_order_brand_color === "string") {
        if (b.public_order_brand_color !== "" && !/^#[0-9A-Fa-f]{6}$/.test(b.public_order_brand_color)) return json(422, { detail: "invalid colour" });
        f.color = b.public_order_brand_color || null;
      }
      if (b.rotate_public_order_link) { f.n += 1; f.slug = `n3w${f.n}x2qd7mwa`; }
      return json(200, settingsOf(f));
    }
    return json(404, { detail: "Not Found" });
  });
}

async function open(page: Page, f: Fake, opts: { w?: number; h?: number; scheme?: "light" | "dark"; perms?: string[] } = {}) {
  await page.setViewportSize({ width: opts.w ?? 1280, height: opts.h ?? 900 });
  await page.emulateMedia({ colorScheme: opts.scheme ?? "light" });
  await mockApi(page, f, opts.perms);
  await signIn(page, fakeJwt());
  await page.goto("/manage?tab=delivery");
}
const card = (page: Page) => page.getByTestId("order-link-card");
const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
/** `previewToo` false: leave the colour preview out (it deliberately shows the owner's own, possibly unreadable, colour; the warning beside it says so). */
async function axe(page: Page, previewToo = true) {
  const b = new AxeBuilder({ page }).include("[data-testid=order-link-card]");
  if (!previewToo) b.exclude("[data-testid=order-link-colour-preview]");
  const r = await b.withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
  return r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}
/** Every button, link and field of the card is at least 44 px tall (the checkbox/switch input itself is inside a 44 px row). */
async function smallTargets(page: Page) {
  return card(page).locator("button:visible, a:visible, input:visible, summary:visible").evaluateAll((els) => els
    .filter((e) => !(e instanceof HTMLInputElement && (e.type === "checkbox" || e.getAttribute("role") === "switch")))
    .map((e) => ({ name: (e.textContent || e.getAttribute("aria-label") || e.tagName).trim().slice(0, 30), h: Math.round(e.getBoundingClientRect().height) }))
    .filter((t) => t.h < 44));
}
async function shot(page: Page, name: string) {
  if (!process.env.SHOT_DIR) return;
  // A tall viewport instead of fullPage: the sticky header, bottom bar and sidebar then appear once, where they really are.
  const v = page.viewportSize()!;
  await page.setViewportSize({ width: v.width, height: 2400 });
  await page.screenshot({ path: `${process.env.SHOT_DIR}/${name}.png` });
  await page.setViewportSize(v);
}

test("off by default: nothing to share, the switch turns the link on", async ({ page }) => {
  const f = fresh();
  await open(page, f);
  await expect(page.getByRole("heading", { name: "Your ordering link" })).toBeVisible();
  await expect(page.getByTestId("order-link-off")).toContainText("Your link is off");
  await expect(page.getByTestId("order-qr")).toHaveCount(0);
  await expect(page.getByTestId("order-link-pickup-hint")).toContainText("cannot choose pickup");
  const sw = page.getByRole("switch", { name: "Online ordering link" });
  await expect(sw).not.toBeChecked();
  await sw.click({ force: true });
  await expect(page.getByTestId("order-link")).toHaveText(`${BASE}k3f9x2qd7mwa`);
  await expect(page.getByTestId("order-qr")).toBeVisible();
  await expect(page.getByText("Ordering link is on")).toBeVisible();
  await expect(sw).toBeChecked();
  expect(f.puts).toEqual([{ public_order_enabled: true }]);
  // and off again: the link and QR go, the PUT is the switch alone
  await sw.click({ force: true });
  await expect(page.getByTestId("order-link-off")).toBeVisible();
  await expect(page.getByTestId("order-qr")).toHaveCount(0);
  expect(f.puts.at(-1)).toEqual({ public_order_enabled: false });
});

test("copy and share: clipboard, Web Share when the browser has it, WhatsApp link when it has not", async ({ page, context }) => {
  const f = fresh({ enabled: true });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(page, f);
  const url = `${BASE}k3f9x2qd7mwa`;
  await page.getByRole("button", { name: "Copy link" }).click();
  await expect(page.getByText("Ordering link copied")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
  // no Web Share API here (desktop Chromium): the WhatsApp fallback
  const wa = page.getByRole("link", { name: "Share on WhatsApp" });
  await expect(wa).toHaveAttribute("href", `https://wa.me/?text=${encodeURIComponent(`Order from us online: ${url}`)}`);
  await expect(wa).toHaveAttribute("target", "_blank");
  await expect(wa).toHaveAttribute("rel", /noopener/);
});

test("share uses the Web Share API when available", async ({ page }) => {
  const f = fresh({ enabled: true });
  await page.addInitScript(() => { (window as unknown as { __shared: unknown[] }).__shared = []; (navigator as unknown as { share: (d: unknown) => Promise<void> }).share = (d) => { (window as unknown as { __shared: unknown[] }).__shared.push(d); return Promise.resolve(); }; });
  await open(page, f);
  await expect(page.getByRole("link", { name: "Share on WhatsApp" })).toHaveCount(0);
  await page.getByRole("button", { name: "Share", exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { __shared: unknown[] }).__shared)).toEqual([{ title: "Order online", text: "Order from us online:", url: `${BASE}k3f9x2qd7mwa` }]);
});

test("QR downloads as SVG and PNG, named from the link", async ({ page }) => {
  await open(page, fresh({ enabled: true }));
  const [svg] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "SVG" }).click()]);
  expect(svg.suggestedFilename()).toBe("ordering-link-qr-k3f9x2qd7mwa.svg");
  const text = await (await import("node:fs/promises")).readFile((await svg.path())!, "utf8");
  expect(text).toContain("<svg");
  expect(text).toContain(`<title>${BASE}k3f9x2qd7mwa</title>`);
  const [png] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "PNG" }).click()]);
  expect(png.suggestedFilename()).toBe("ordering-link-qr-k3f9x2qd7mwa.png");
  const bytes = await (await import("node:fs/promises")).readFile((await png.path())!);
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a"); // PNG signature
  expect(bytes.length).toBeGreaterThan(1000);
});

test("Make a new link asks first: Cancel changes nothing, Confirm swaps link and QR", async ({ page }) => {
  const f = fresh({ enabled: true });
  await open(page, f);
  const before = await page.getByTestId("order-qr").locator("path").getAttribute("d");
  await page.getByRole("button", { name: "Make a new link" }).click();
  const dlg = page.getByRole("alertdialog", { name: "Make a new link?" });
  await expect(dlg).toContainText("Your old link and QR code stop working right away");
  await expect(dlg.getByRole("button", { name: "Cancel" })).toBeFocused(); // destructive: starts on Cancel
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await expect(dlg).toHaveCount(0);
  expect(f.puts).toEqual([]);
  await page.getByRole("button", { name: "Make a new link" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Make a new link" }).click();
  await expect(page.getByTestId("order-link")).toHaveText(`${BASE}n3w1x2qd7mwa`);
  await expect(page.getByText("New link is ready")).toBeVisible();
  expect(f.puts).toEqual([{ rotate_public_order_link: true }]);
  expect(await page.getByTestId("order-qr").locator("path").getAttribute("d")).not.toBe(before);
});

test("502 keeps the saved settings, says it plainly and Retry works; the one-time secret of that call is shown", async ({ page }) => {
  const f = fresh({ mode: "down", secretPending: true });
  await open(page, f);
  const sw = page.getByRole("switch", { name: "Online ordering link" });
  await sw.click({ force: true });
  const err = page.getByTestId("order-link-error");
  await expect(err).toHaveText(UNAVAILABLE);
  await expect(sw).not.toBeChecked(); // not flipped
  await expect(page.getByTestId("order-qr")).toHaveCount(0);
  await expect(page.getByText("Copy the signing secret now")).toBeVisible(); // from settings in the 502 body
  await expect(page.getByText("whsec_one_time_secret")).toBeVisible();
  f.mode = "ok";
  await card(page).getByRole("button", { name: "Retry" }).click();
  await expect(page.getByTestId("order-link")).toHaveText(`${BASE}k3f9x2qd7mwa`);
  await expect(err).toHaveCount(0);
  expect(f.puts).toEqual([{ public_order_enabled: true }, { public_order_enabled: true }]);
});

test("not connected to the delivery service: a short explanation, Advanced opens, Try again", async ({ page }) => {
  const f = fresh({ mode: "not_connected" });
  await open(page, f);
  await expect(page.getByTestId("order-link-advanced")).not.toHaveAttribute("open", "");
  await page.getByRole("switch", { name: "Online ordering link" }).click({ force: true });
  await expect(page.getByText("Not connected to the online ordering service")).toBeVisible();
  await expect(page.getByTestId("order-link-not-connected")).toContainText("Support connects it for your restaurant");
  await expect(page.getByTestId("order-link-advanced")).toHaveAttribute("open", "");
  await expect(page.getByRole("switch", { name: "Online ordering link" })).not.toBeChecked();
  await expect(page.getByTestId("order-qr")).toHaveCount(0);
  f.mode = "ok";
  await card(page).getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("order-qr")).toBeVisible();
});

test("409 link off: rotate or colour while the link went off elsewhere says so and the card follows the server", async ({ page }) => {
  const f = fresh({ enabled: true });
  await open(page, f);
  await expect(page.getByTestId("order-qr")).toBeVisible();
  f.enabled = false; // switched off from another device
  await page.getByRole("button", { name: "Make a new link" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Make a new link" }).click();
  await expect(page.getByTestId("order-link-off-notice")).toContainText("The link is off. Turn it on first");
  await expect(page.getByRole("switch", { name: "Online ordering link" })).not.toBeChecked(); // reloaded
  await expect(page.getByTestId("order-qr")).toHaveCount(0);
  expect(f.puts).toEqual([{ rotate_public_order_link: true }]);
});

test("switch on but the delivery service gives no URL: a calm notice with Check again", async ({ page }) => {
  const f = fresh({ enabled: true, noUrl: true });
  await open(page, f);
  await expect(page.getByTestId("order-link-no-url")).toContainText("did not give us the link");
  await expect(page.getByTestId("order-qr")).toHaveCount(0);
  f.noUrl = false;
  await card(page).getByRole("button", { name: "Check again" }).click();
  await expect(page.getByTestId("order-qr")).toBeVisible();
});

test("service token: write-only, never shown or logged, only when not set or on Replace", async ({ page }) => {
  const f = fresh();
  const logs: string[] = [];
  page.on("console", (m: ConsoleMessage) => logs.push(m.text()));
  page.on("pageerror", (e) => logs.push(String(e)));
  await open(page, f);
  const adv = page.getByTestId("order-link-advanced");
  await adv.getByText("Advanced").click();
  const input = page.getByLabel("Service token");
  await expect(input).toHaveAttribute("type", "password");
  await input.fill(TOKEN_SECRET);
  await page.getByRole("button", { name: "Save token" }).click();
  await expect(page.getByText("Service token saved", { exact: true }).first()).toBeVisible();
  expect(f.puts).toEqual([{ public_order_service_token: TOKEN_SECRET }]);
  await expect(page.getByLabel("Service token")).toHaveCount(0); // not offered again while one is stored
  expect(await page.content()).not.toContain(TOKEN_SECRET);
  expect(await page.locator("input").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))).not.toContain(TOKEN_SECRET);
  // Replace brings the field back, empty
  await page.getByRole("button", { name: "Replace token" }).click();
  await expect(page.getByLabel("New service token")).toHaveValue("");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: "Replace token" })).toBeVisible();
  expect(logs.join("\n")).not.toContain(TOKEN_SECRET);
});

test("brand colour: #RRGGBB check, preview, AA warning, save and reset", async ({ page }) => {
  const f = fresh({ enabled: true });
  await open(page, f);
  const field = page.getByLabel("Colour code");
  await field.fill("green");
  await expect(card(page).getByText("Use six digits after #")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save colour" })).toBeDisabled();
  await field.fill("0b6e4f"); // typed without # and in lower case
  await expect(page.getByTestId("order-link-colour-preview")).toContainText("Label contrast");
  await expect(page.getByTestId("order-link-colour-warning")).toHaveCount(0); // a fine label; only a note about small text on the dark surface
  await expect(page.getByTestId("order-link-colour-note")).toContainText("little darker or lighter");
  await page.getByRole("button", { name: "Save colour" }).click();
  await expect(page.getByText("Colour saved")).toBeVisible();
  expect(f.puts).toEqual([{ public_order_brand_color: "#0B6E4F" }]);
  await expect(page.getByRole("button", { name: "Save colour" })).toBeDisabled(); // nothing new to save
  await field.fill("#797979"); // fails AA for a label either way
  await expect(page.getByTestId("order-link-colour-warning")).toContainText("hard to read");
  await field.fill("#FFD60A");
  await expect(page.getByTestId("order-link-colour-warning")).toHaveCount(0);
  await expect(page.getByTestId("order-link-colour-note")).toContainText("little darker or lighter");
  await page.getByRole("button", { name: "Use default colour" }).click();
  await expect(page.getByText("Back to the default colour")).toBeVisible();
  expect(f.puts.at(-1)).toEqual({ public_order_brand_color: "" });
  await expect(field).toHaveValue("");
});

test("a user without delivery.manage has no Delivery tab", async ({ page }) => {
  await open(page, fresh({ enabled: true }), { perms: ["delivery.accept"] });
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Manage sections" }).getByRole("link", { name: "Delivery" })).toHaveCount(0);
  await expect(page.getByTestId("order-link-card")).toHaveCount(0);
});

test("an older server without the switch keeps the read-only link", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/api\/v1/, "");
    if (path === "/auth/me") return route.fulfill({ json: ME(PERMS) });
    if (path === "/delivery/admin/orders") return route.fulfill({ json: [] });
    if (path === "/delivery/settings") { const old: Record<string, unknown> = { ...settingsOf(fresh({ enabled: true })), public_order_url: `${BASE}old1` }; delete old.public_order_enabled; delete old.public_order_token_set; return route.fulfill({ json: old }); }
    return route.fulfill({ status: 404, json: {} });
  });
  await signIn(page, fakeJwt());
  await page.goto("/manage?tab=delivery");
  await expect(page.getByTestId("order-link")).toHaveText(`${BASE}old1`);
  await expect(page.getByRole("switch", { name: "Online ordering link" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Make a new link" })).toHaveCount(0);
});

for (const [w, h] of [[390, 844], [1280, 900]] as const) {
  for (const scheme of ["light", "dark"] as const) {
    test(`look @${w} ${scheme}: states, no horizontal scroll, 44 px targets, axe`, async ({ page }) => {
      const f = fresh({ enabled: true });
      await open(page, f, { w, h, scheme });
      await expect(page.getByTestId("order-qr")).toBeVisible();
      await page.getByLabel("Colour code").fill("#0B6E4F");
      await page.getByTestId("order-link-advanced").getByText("Advanced").click();
      await expect(page.getByLabel("Service token")).toBeVisible();
      await card(page).scrollIntoViewIfNeeded();
      await shot(page, `on-${w}-${scheme}`);
      expect(await noHScroll(page)).toBe(true);
      expect(await smallTargets(page)).toEqual([]);
      expect(await axe(page), "axe on state").toEqual([]);
      await page.getByLabel("Colour code").fill("#797979");
      await expect(page.getByTestId("order-link-colour-warning")).toBeVisible();
      await shot(page, `on-low-contrast-${w}-${scheme}`);
      expect(await axe(page, false), "axe on low-contrast warning").toEqual([]);

      // off
      f.enabled = false; await page.reload();
      await expect(page.getByTestId("order-link-off")).toBeVisible();
      await shot(page, `off-${w}-${scheme}`);
      expect(await axe(page), "axe off").toEqual([]);
      expect(await smallTargets(page)).toEqual([]);

      // 502
      f.mode = "down";
      await page.getByRole("switch", { name: "Online ordering link" }).click({ force: true });
      await expect(page.getByTestId("order-link-error")).toBeVisible();
      await shot(page, `error-502-${w}-${scheme}`);
      expect(await axe(page), "axe 502").toEqual([]);
      expect(await smallTargets(page)).toEqual([]);

      // not connected
      f.mode = "not_connected";
      await card(page).getByRole("button", { name: "Retry" }).click();
      await expect(page.getByTestId("order-link-not-connected")).toBeVisible();
      await shot(page, `not-connected-${w}-${scheme}`);
      expect(await axe(page), "axe not connected").toEqual([]);
      expect(await noHScroll(page)).toBe(true);

      // confirm dialog
      f.mode = "ok"; f.enabled = true; await page.reload();
      await page.getByRole("button", { name: "Make a new link" }).click();
      await expect(page.getByRole("alertdialog")).toBeVisible();
      if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/confirm-${w}-${scheme}.png` }); // viewport: the dialog is over the page
      expect(await noHScroll(page)).toBe(true);
    });
  }
}
