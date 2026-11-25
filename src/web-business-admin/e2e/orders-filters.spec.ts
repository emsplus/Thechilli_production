import { expect, test } from "@playwright/test";
import { API, openAs, seedIn } from "./helpers";

// UI_REVIEW BA-14: running orders first, cancelled / voided out of the default view behind a chip, counts on every chip.
test("orders: running first, All includes cancelled, chips add up", async ({ page, request }) => {
  const s = await seedIn(request);
  const order = async () => (await (await request.post(`${API}/orders`, { headers: s.auth, data: { client_uuid: crypto.randomUUID(), order_type: "takeaway", lines: [{ item_id: s.itemId, quantity: 1 }] } })).json()) as { id: string };
  // one paid, three cancelled, one in the kitchen, one open
  const paid = await order();
  const bill = await (await request.post(`${API}/orders/${paid.id}/bill`, { headers: s.auth })).json();
  expect((await request.post(`${API}/bills/${bill.id}/payments`, { headers: s.auth, data: { idempotency_key: crypto.randomUUID(), method: "cash", amount: bill.total } })).ok()).toBeTruthy();
  for (let i = 0; i < 3; i++) { const c = await order(); expect((await request.post(`${API}/orders/${c.id}/cancel`, { headers: s.auth, data: { reason: "Demo reset" } })).ok()).toBeTruthy(); }
  const k = await order(); await request.post(`${API}/orders/${k.id}/kot`, { headers: s.auth });
  await order();

  await openAs(page, s.token, "/orders", s.refresh);
  const chips = page.getByRole("radiogroup", { name: "Filter by status" });
  // All is every order (cancelled too); the other chips never overlap, so they add up to All.
  await expect(chips.getByRole("radio", { name: /^All\s*6$/ })).toBeChecked();
  await expect(chips.getByRole("radio", { name: /^Open\s*1$/ })).toBeVisible();
  await expect(chips.getByRole("radio", { name: /^In kitchen\s*1$/ })).toBeVisible();
  await expect(chips.getByRole("radio", { name: /^Paid\s*1$/ })).toBeVisible();
  await expect(chips.getByRole("radio", { name: /^Cancelled & voided\s*3$/ })).toBeVisible();
  const cards = page.getByTestId("order-card");
  await expect(cards).toHaveCount(6);
  // Running orders first, then the paid one, then the cancelled ones.
  await expect(cards.nth(2)).toContainText(bill.invoice_number);
  await chips.getByRole("radio", { name: /^Cancelled & voided/ }).click();
  await expect(cards).toHaveCount(3);
  await expect(page.getByText(/Cancelled: Demo reset/)).toHaveCount(3);
  await chips.getByRole("radio", { name: /^In kitchen/ }).click();
  await expect(cards).toHaveCount(1);
});
