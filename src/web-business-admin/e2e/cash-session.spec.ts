import { expect, test, type Page } from "@playwright/test";
import { openAs, seed } from "./helpers";

// Cash drawer UI against mocked /cash-sessions (pos-service phase2/void is not merged into the server these specs run against).
// Contract: docs/CASH_SESSIONS.md on that branch.

const session = (extra: Record<string, unknown> = {}) => ({ id: "5f0c2c1e-0000-4000-8000-000000000001", status: "open", opened_at: new Date().toISOString(), opening_float: "500.00", expected_cash: "1200.00", ...extra });
/** The signed-in user's id (JWT sub): the open-drawer list is filtered by it. */
const sub = (token: string) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub as string;
/** GET /cash-sessions?status=open (the app reads the caller's drawer from this list: 200, never a 404). */
const LIST = /\/cash-sessions\?/;
const withShiftPermission = (page: Page) => page.route("**/auth/me", async (route) => {
  const res = await route.fetch(); const me = await res.json();
  await route.fulfill({ response: res, json: { ...me, permissions: [...(me.permissions ?? []), "cashier.shift"] } });
});

test("old server (no cashier.shift, no route): the page explains instead of failing", async ({ page, request }) => {
  const s = await seed(request);
  // The server these specs run against now has cash sessions and gives the owner cashier.shift: take both away in the browser to act as an old server.
  await page.route("**/auth/me", async (route) => { const res = await route.fetch(); const me = await res.json(); await route.fulfill({ response: res, json: { ...me, permissions: (me.permissions ?? []).filter((p: string) => p !== "cashier.shift") } }); });
  await page.route("**/cash-sessions**", (route) => route.fulfill({ status: 404, json: { detail: "Not Found" } }));
  await openAs(page, s.token, "/cash", s.refresh);
  await expect(page.getByText("Cash drawer is not available")).toBeVisible();
});

test("open a shift with a float, then close it: a short count needs a reason", async ({ page, request }) => {
  const s = await seed(request);
  await withShiftPermission(page);
  let current: ReturnType<typeof session> | null = null;
  let opened: Record<string, string> = {}; let closed: Record<string, string> = {};
  await page.route("**/cash-sessions/current", (r) => current ? r.fulfill({ json: current }) : r.fulfill({ status: 404, json: { detail: "No open cash session" } }));
  await page.route(LIST, (r) => r.fulfill({ json: current ? [{ ...current, cashier_id: sub(s.token) }] : [] }));
  await page.route("**/cash-sessions", async (r) => { opened = r.request().postDataJSON(); current = session(); await r.fulfill({ status: 201, json: current }); });
  await page.route("**/cash-sessions/*/close", async (r) => { closed = r.request().postDataJSON(); current = null; await r.fulfill({ json: session({ status: "closed", counted_cash: closed.counted_cash, variance: "-20.00", variance_reason: closed.variance_reason }) }); });

  await openAs(page, s.token, "/cash", s.refresh);
  await expect(page.getByText("No shift open")).toBeVisible();
  await page.getByRole("button", { name: "Open shift" }).first().click();
  await expect(page.getByRole("button", { name: "Open shift" }).last()).toBeDisabled();   // needs an amount
  await page.getByLabel("Opening float").fill("500");
  await page.getByRole("dialog").getByRole("button", { name: "Open shift" }).click();
  await expect(page.getByText("Shift open", { exact: true })).toBeVisible();
  expect(opened.opening_float).toBe("500");
  expect(opened.idempotency_key).toBeTruthy();
  await expect(page.getByTestId("cash-expected")).toContainText("1,200");

  await page.getByRole("button", { name: "Close shift" }).first().click();
  await page.getByLabel("Cash counted").fill("1180");
  await expect(page.getByTestId("cash-variance")).toContainText("Short by");
  await expect(page.getByRole("dialog").getByRole("button", { name: "Close shift" })).toBeDisabled(); // reason required
  await page.getByLabel("Why does it not match?").fill("Gave wrong change");
  await page.getByRole("dialog").getByRole("button", { name: "Close shift" }).click();
  await expect(page.getByTestId("last-close")).toContainText("Gave wrong change");
  expect(closed).toMatchObject({ counted_cash: "1180", variance_reason: "Gave wrong change" });
});

test("a matching count closes without a reason", async ({ page, request }) => {
  const s = await seed(request);
  await withShiftPermission(page);
  let body: Record<string, string> = {};
  await page.route("**/cash-sessions/current", (r) => r.fulfill({ json: session() }));
  // Another cashier's open drawer (owners see everyone's) is never taken for the caller's own.
  await page.route(LIST, (r) => r.fulfill({ json: [session({ id: "other", cashier_id: "00000000-0000-4000-8000-00000000beef", opening_float: "9.00" }), { ...session(), cashier_id: sub(s.token) }] }));
  await page.route("**/cash-sessions/*/close", async (r) => { body = r.request().postDataJSON(); await r.fulfill({ json: session({ status: "closed", counted_cash: "1200", variance: "0.00" }) }); });
  await openAs(page, s.token, "/cash", s.refresh);
  await page.getByRole("button", { name: "Close shift" }).first().click();
  await page.getByLabel("Cash counted").fill("1200");
  await expect(page.getByTestId("cash-variance")).toContainText("Matches");
  await page.getByRole("dialog").getByRole("button", { name: "Close shift" }).click();
  await expect(page.getByTestId("last-close")).toBeVisible();
  expect(body.variance_reason).toBeUndefined();
});
