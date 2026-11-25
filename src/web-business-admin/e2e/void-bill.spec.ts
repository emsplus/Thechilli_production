import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API, openAs, seed } from "./helpers";

// Void bill UI. The pos-service branch phase2/void (POST /bills/{id}/void, permission bills.void) is not merged into the server
// these specs run against, so /auth/me and the void route are mocked in the browser: this checks the UI contract only.

async function paidBill(request: APIRequestContext, s: Awaited<ReturnType<typeof seed>>) {
  const o = await (await request.post(`${API}/orders`, { headers: s.auth, data: { client_uuid: crypto.randomUUID(), order_type: "takeaway", lines: [{ item_id: s.itemId, quantity: 1 }] } })).json();
  const b = await (await request.post(`${API}/orders/${o.id}/bill`, { headers: s.auth, data: {} })).json();
  await request.post(`${API}/bills/${b.id}/payments`, { headers: s.auth, data: { idempotency_key: crypto.randomUUID(), method: "cash", amount: b.total } });
  return b as { id: string; invoice_number: string; total: string };
}
const withVoidPermission = (page: Page) => page.route("**/auth/me", async (route) => {
  const res = await route.fetch(); const me = await res.json();
  await route.fulfill({ response: res, json: { ...me, permissions: [...(me.permissions ?? []), "bills.void"] } });
});
async function openBill(page: Page, invoice: string) {
  await page.getByTestId("order-card").first().getByRole("button", { name: "View bill" }).click();
  await expect(page.getByRole("dialog").getByText(invoice).first()).toBeVisible();
}

test("no bills.void permission: no Void button", async ({ page, request }) => {
  const s = await seed(request);
  const b = await paidBill(request, s);
  // The owner now holds bills.void on the real server: take it away in the browser to test the no-permission view.
  await page.route("**/auth/me", async (route) => { const res = await route.fetch(); const me = await res.json(); await route.fulfill({ response: res, json: { ...me, permissions: (me.permissions ?? []).filter((p: string) => p !== "bills.void") } }); });
  await openAs(page, s.token, "/orders", s.refresh);
  await openBill(page, b.invoice_number);
  await expect(page.getByTestId("void-bill")).toHaveCount(0);
});

test("void: reason is required, a confirm step follows, the hand-back note and amount are shown", async ({ page, request }) => {
  const s = await seed(request);
  const b = await paidBill(request, s);
  await withVoidPermission(page);
  let body: { reason?: string; idempotency_key?: string } = {};
  await page.route("**/bills/*/void", async (route) => {
    body = route.request().postDataJSON();
    await route.fulfill({ status: 201, json: { id: b.id, status: "voided", refund_due: { amount: b.total, by_method: { cash: b.total }, note: "hand back" } } });
  });
  await openAs(page, s.token, "/orders", s.refresh);
  await openBill(page, b.invoice_number);
  await page.getByTestId("void-bill").click();
  const dlg = page.getByRole("dialog", { name: "Void this bill?" });
  await expect(dlg.getByText(/handed back manually/)).toBeVisible();
  await dlg.getByRole("radio", { name: "Other" }).click();
  await expect(dlg.getByRole("button", { name: "Void bill" })).toBeDisabled();  // reason required
  await dlg.getByLabel("Describe the reason").fill("Rung up twice");
  await dlg.getByRole("button", { name: "Void bill" }).click();
  await page.getByRole("button", { name: "Yes, void the bill" }).click();       // explicit confirm
  await expect(page.getByTestId("void-refund-due")).toBeVisible();
  expect(body.reason).toBe("Rung up twice");
  expect(body.idempotency_key).toBeTruthy();
});

test("a server without the void route (404): friendly message and the button disappears", async ({ page, request }) => {
  const s = await seed(request);
  const b = await paidBill(request, s);
  await withVoidPermission(page);
  await page.route("**/bills/*/void", (route) => route.fulfill({ status: 404, json: { detail: "Not Found" } }));
  await openAs(page, s.token, "/orders", s.refresh);
  await openBill(page, b.invoice_number);
  await page.getByTestId("void-bill").click();
  await page.getByRole("button", { name: "Void bill" }).click();
  await page.getByRole("button", { name: "Yes, void the bill" }).click();
  await expect(page.getByText("does not support voiding bills yet")).toBeVisible();
  await page.getByRole("button", { name: "Keep bill" }).first().click();
  await expect(page.getByTestId("void-bill")).toHaveCount(0);
});
