import { expect, test, type Page, type Route } from "@playwright/test";
import { signIn } from "./helpers";

// Chilli wallet (docs/CHILLI_WALLET.md): balance in Chilli, Recharge (default ₹2,000, Razorpay link in a new tab, "Added 2,000 Chilli"
// after the webhook), low / empty banners for everyone, and the plain 402 chilli_empty message on a NEW order. Every API call is mocked.
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const fakeJwt = () => `${b64({ alg: "none" })}.${b64({ sub: "u1", rid: "r1", exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
const OWNER = ["settings.owner", "settings.view", "billing.view", "billing.topup", "orders.create", "orders.view", "menu.view"];
const STAFF = ["settings.view", "billing.view", "orders.create", "orders.view", "menu.view"];
const BLOCK = { state: "active", model: "payg", balance_paise: 125_000, per_bill_paise: 500, low_balance_paise: 10_000, min_topup_paise: 200_000, max_topup_paise: 10_000_000, topup_online: true, bills_left: 250, days_left: 0 };
const me = (perms: string[], billing: object) => ({ id: "u1", email: "o@example.in", full_name: "Owner", role: "owner", is_active: true, restaurant_name: "Spice Garden", permissions: perms,
  business_types: ["restaurant"], capabilities: { dine_in: true, tables: true }, billing });

async function mock(page: Page, o: { perms?: string[]; billing?: object; paidAfter?: number; log?: { intent?: unknown; polls: number } }) {
  const perms = o.perms ?? OWNER; let billing = o.billing ?? BLOCK;
  await page.route("**/api/v1/**", (route: Route) => {
    const req = route.request(); const path = new URL(req.url()).pathname.replace(/^.*\/api\/v1/, "");
    if (path === "/auth/me") return route.fulfill({ json: me(perms, billing) });
    if (path === "/billing/wallet") return route.fulfill({ json: { billing, source: "live" } });
    if (path === "/billing/ledger") return route.fulfill({ json: { items: [{ id: 1, kind: "topup", amount_paise: 200_000, balance_after_paise: 325_000, created_at: "2026-11-02T10:00:00Z", ref: null }], total: 1, limit: 20, offset: 0 } });
    if (path.startsWith("/billing/usage")) return route.fulfill({ status: 404, json: { detail: "n/a" } });
    if (path === "/billing/topups/intent") { if (o.log) o.log.intent = JSON.parse(req.postData() ?? "{}");
      return route.fulfill({ status: 201, json: { intent: { id: "11111111-1111-4111-8111-111111111111", status: "created", amount_paise: 200_000 }, checkout: { url: "https://rzp.example/pay" } } }); }
    if (path.startsWith("/billing/topups/")) { const n = ++(o.log!.polls); const paid = n > (o.paidAfter ?? 1);
      if (paid) billing = { ...BLOCK, balance_paise: 325_000 };
      return route.fulfill({ json: { intent: { id: "11111111-1111-4111-8111-111111111111", status: paid ? "paid" : "created", amount_paise: 200_000 }, billing: paid ? billing : undefined } }); }
    if (path === "/restaurant") return route.fulfill({ json: { name: "Spice Garden", currency: "INR", timezone: "Asia/Kolkata", country: "IN", currency_symbol: "₹", prices_include_tax: false } });
    return route.fulfill({ json: [] });
  });
}

test("Billing shows Chilli, Recharge defaults to 2,000 and the paid recharge shows 'Added 2,000 Chilli'", async ({ page, context }) => {
  const log: { intent?: unknown; polls: number } = { polls: 0 };
  await page.setViewportSize({ width: 1280, height: 900 });
  await mock(page, { log, paidAfter: 1 });
  await signIn(page, fakeJwt());
  await page.goto("/manage?tab=billing");
  await expect(page.getByTestId("credit-balance")).toHaveText("1,250 Chilli");
  await page.getByTestId("recharge-open").click();
  await expect(page.getByTestId("recharge-amount")).toHaveValue("2000");
  await expect(page.getByTestId("recharge-get")).toHaveText("You get 2,000 Chilli");
  await page.getByTestId("recharge-amount").fill("1500");
  await page.getByTestId("recharge-pay").click();
  await expect(page.getByText("The smallest recharge is ₹2,000")).toBeVisible();
  await page.getByRole("button", { name: "₹5,000" }).click();
  await expect(page.getByTestId("recharge-pay")).toHaveText("Pay ₹5,000");
  await page.getByRole("button", { name: "₹2,000" }).first().click();
  await context.route("https://rzp.example/**", (r) => r.fulfill({ contentType: "text/html", body: "<title>Razorpay</title>pay" }));
  const popup = context.waitForEvent("page");
  await page.getByTestId("recharge-pay").click();
  expect((await popup).url()).toContain("rzp.example/pay");
  await expect(page.getByTestId("recharge-link")).toHaveCount(0); // the tab opened, so no "pop-up blocked" fallback
  expect(log.intent).toEqual({ amount_paise: 200_000 });
  await expect(page.getByTestId("recharge-status")).toHaveAttribute("data-kind", "paid", { timeout: 20_000 });
  await expect(page.getByTestId("recharge-status")).toContainText("Added 2,000 Chilli");
  await expect(page.getByTestId("credit-balance")).toHaveText("3,250 Chilli");
});

test("grace: 'N orders left before billing stops' on every screen and on Billing, no blocking message", async ({ page }) => {
  const grace = { ...BLOCK, state: "grace", balance_paise: -2_500, bills_left: 15, orders_left: 15, grace_orders: 20, grace_paise: 10_000 };
  await page.setViewportSize({ width: 1280, height: 900 });
  await mock(page, { billing: grace });
  await signIn(page, fakeJwt());
  await page.goto("/manage?tab=billing");
  await expect(page.getByTestId("chilli-banner")).toHaveAttribute("data-state", "grace");
  await expect(page.getByTestId("chilli-banner")).toContainText("15 orders left before billing stops");
  await expect(page.getByTestId("chilli-banner")).not.toContainText("Recharge to continue");
  await expect(page.getByTestId("credit-balance")).toHaveText("-25 Chilli");
  await expect(page.getByText("Orders left before billing stops", { exact: true })).toBeVisible();
  await expect(page.getByTestId("chilli-recharge-link")).toBeVisible();
});

test("blocked Chilli: a banner on every screen; the owner can recharge, staff are told to ask the owner", async ({ page }) => {
  const empty = { ...BLOCK, state: "blocked", balance_paise: -10_000, bills_left: 0, blocked: true, grace_orders: 20, grace_paise: 10_000 };
  await page.setViewportSize({ width: 1280, height: 900 });
  await mock(page, { billing: empty });
  await signIn(page, fakeJwt());
  await page.goto("/manage?tab=billing");
  await expect(page.getByTestId("chilli-banner")).toContainText("Recharge to continue");
  await expect(page.getByTestId("chilli-recharge-link")).toBeVisible();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await mock(page, { billing: empty, perms: STAFF });
  await page.reload();
  await expect(page.getByTestId("chilli-banner")).toContainText("Ask the owner to recharge");
  await expect(page.getByTestId("chilli-recharge-link")).toHaveCount(0);
});

test("low Chilli warns; a healthy balance shows no banner", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mock(page, { billing: { ...BLOCK, state: "low", balance_paise: 8_000, bills_left: 16 } });
  await signIn(page, fakeJwt());
  await page.goto("/manage?tab=billing");
  await expect(page.getByTestId("chilli-banner")).toContainText("80 Chilli left");
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await mock(page, {});
  await page.reload();
  await expect(page.getByTestId("credit-balance")).toBeVisible();
  await expect(page.getByTestId("chilli-banner")).toHaveCount(0);
});

test("recharge not set up yet: the button only explains", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mock(page, { billing: { ...BLOCK, topup_online: false } });
  await signIn(page, fakeJwt());
  await page.goto("/manage?tab=billing");
  await page.getByTestId("recharge-open").click();
  await expect(page.getByTestId("topup-soon")).toContainText("not set up yet");
});
