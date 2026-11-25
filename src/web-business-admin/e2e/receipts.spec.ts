import { expect, test, type APIRequestContext } from "@playwright/test";
import { payCash, API, openPos, seed, type Seed } from "./helpers";

async function paidBill(request: APIRequestContext, s: Seed) {
  const order = await (await request.post(`${API}/orders`, { headers: s.auth, data: {
    client_uuid: crypto.randomUUID(), order_type: "indoor", table_id: s.tableId, lines: [{ item_id: s.itemId, quantity: 2, note: "no ice" }] } })).json();
  const kot = await (await request.post(`${API}/orders/${order.id}/kot`, { headers: s.auth })).json();
  const bill = await (await request.post(`${API}/orders/${order.id}/bill`, { headers: s.auth })).json();
  await request.post(`${API}/bills/${bill.id}/payments`, { headers: s.auth, data: { idempotency_key: crypto.randomUUID(), method: "cash", amount: bill.total } });
  return { bill, kot };
}

const mediaBox = (pdf: Buffer) => {
  const m = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(pdf.toString("latin1"));
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
};

test("API: thermal receipt, share link + public download, KOT slip", async ({ request }) => {
  const s = await seed(request);
  const { bill, kot } = await paidBill(request, s);

  const r = await request.get(`${API}/bills/${bill.id}/receipt.pdf`, { headers: s.auth });
  expect(r.ok()).toBeTruthy();
  const pdf = await r.body();
  expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  expect(Math.abs(mediaBox(pdf)!.w - 226.8)).toBeLessThan(0.5);

  const a5 = await (await request.get(`${API}/bills/${bill.id}/receipt.pdf?size=a5`, { headers: s.auth })).body();
  expect(mediaBox(a5)!.w).toBeGreaterThan(400);

  const share = await (await request.post(`${API}/bills/${bill.id}/share-link`, { headers: s.auth })).json();
  expect(share.filename).toBe(`${bill.invoice_number}.pdf`);
  const pub = await request.get(share.url); // no Authorization header
  expect(pub.status()).toBe(200);
  expect(pub.headers()["content-type"]).toContain("application/pdf");
  expect(pub.headers()["x-robots-tag"]).toBe("noindex");
  expect((await pub.body()).subarray(0, 4).toString()).toBe("%PDF");
  const tampered = share.url.replace(/(.{4})\.pdf$/, (_: string, x: string) => `${x[0] === "A" ? "B" : "A"}${x.slice(1)}.pdf`);
  expect((await request.get(tampered)).status()).toBe(404);

  const slip = await request.get(`${API}/kot/${kot.id}/slip.pdf`, { headers: s.auth });
  expect(slip.ok()).toBeTruthy();
  const slipPdf = await slip.body();
  expect(slipPdf.subarray(0, 4).toString()).toBe("%PDF");
  expect(Math.abs(mediaBox(slipPdf)!.w - 226.8)).toBeLessThan(0.5);
  expect((await request.get(`${API}/kot/${kot.id}/slip.pdf`)).status()).toBe(401);
});

test("UI: Print, Download and WhatsApp share after payment", async ({ page, context, request }) => {
  const s = await seed(request);
  await context.route("https://wa.me/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "wa" }));
  // Force the link flow even on browsers that can share files through the OS sheet.
  await page.addInitScript(() => { Object.defineProperty(navigator, "canShare", { value: undefined, configurable: true }); });
  await openPos(page, s.token);
  await page.getByRole("button", { name: /Latte/ }).first().click();
  await page.getByRole("button", { name: "Place order" }).click();
  await page.getByRole("button", { name: /Send to kitchen/ }).click();
  await expect(page.getByRole("button", { name: /Kitchen ticket #1 sent/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Print kitchen ticket" })).toBeVisible();
  await page.getByRole("button", { name: "Make bill" }).click();
  await expect(page.getByText(/INV[-/]\d{4}[-/]000001/).first()).toBeVisible();
  await payCash(page);
  await expect(page.getByRole("button", { name: "New order" })).toBeVisible();

  const actions = page.getByTestId("bill-actions");
  await expect(actions.getByRole("button", { name: "Print" })).toBeVisible();
  await expect(actions.getByRole("button", { name: "Download PDF" })).toBeVisible();
  const download = page.waitForEvent("download");
  await actions.getByRole("button", { name: "Download PDF" }).click();
  expect((await download).suggestedFilename()).toMatch(/^INV-\d{4}-000001\.pdf$/);

  await actions.getByRole("button", { name: "Share on WhatsApp" }).click();
  await page.getByLabel("Customer mobile number").fill("98765 43210");
  const popupPromise = context.waitForEvent("page");
  await page.getByRole("button", { name: "Open WhatsApp" }).click();
  const popup = await popupPromise;
  await popup.waitForURL(/^https:\/\/wa\.me\/919876543210\?text=/);
  expect(decodeURIComponent(popup.url())).toContain("/api/v1/public/receipts/");
});
