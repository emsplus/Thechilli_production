import { expect, test, type APIRequestContext } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { API, openAs, seed, type Seed } from "./helpers";

const mk = async (request: APIRequestContext, s: Seed, name: string, phone: string) => {
  const r = await request.post(`${API}/customers`, { headers: s.auth, data: { name, phone } });
  expect(r.status()).toBe(201);
  return (await r.json()) as { id: string };
};
/** An unpaid order for the customer, billed: it shows in the customer's purchase history. */
async function bill(request: APIRequestContext, s: Seed, customerId: string) {
  const o = await (await request.post(`${API}/orders`, { headers: s.auth, data: { client_uuid: crypto.randomUUID(), order_type: "takeaway", table_id: null, customer_id: customerId, lines: [{ item_id: s.itemId, quantity: 3 }] } })).json();
  const b = await request.post(`${API}/orders/${o.id}/bill`, { headers: s.auth, data: {} });
  expect(b.status()).toBe(201);
}

test("search, filters and sorting over the customers table, with India-friendly names", async ({ page, request }) => {
  const s = await seed(request);
  const rahul = await mk(request, s, "राहुल शर्मा", "+919876500111");
  await mk(request, s, "Priya Iyer", "+919876500222");
  await mk(request, s, "Mohammed Ali", "+919876500333");
  await bill(request, s, rahul.id);
  await request.post(`${API}/customers/${rahul.id}/consent`, { headers: s.auth, data: { channel: "whatsapp", granted: true, source: "Signed form" } });
  await openAs(page, s.token, "/manage?tab=customers", s.refresh);
  const table = page.getByRole("table", { name: "Customers" });
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "राहुल शर्मा, open details" })).toBeVisible();
  await expect(page.getByText("Repeat customers")).toBeVisible();

  await page.getByLabel("Search customers").fill("priya");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await page.getByLabel("Search customers").fill("zzzz");
  await expect(page.getByText("No matching customers")).toBeVisible();
  await page.getByLabel("Search customers").fill("");

  await page.getByLabel("Marketing consent").selectOption("whatsapp");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await page.getByRole("button", { name: "Reset" }).click();
  await page.getByLabel("Visits").selectOption("none");
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await page.getByRole("button", { name: "Reset" }).click();

  await table.getByRole("button", { name: /Visits/ }).click();
  await table.getByRole("button", { name: /Visits/ }).click(); // descending: the customer with a bill is first
  await expect(table.locator("tbody tr").first()).toContainText("राहुल शर्मा");
});

test("customer sheet: purchase history, consent with confirmation, edit, and CSV exports", async ({ page, request }) => {
  const s = await seed(request);
  const c = await mk(request, s, "Sam Regular", "+919876500444");
  await bill(request, s, c.id);
  await openAs(page, s.token, "/manage?tab=customers", s.refresh);
  await page.getByRole("button", { name: "Sam Regular, open details" }).click();
  const sheet = page.getByRole("dialog", { name: "Sam Regular" });
  await expect(sheet.getByText(/INV[-/]\d{4}[-/]000001/)).toBeVisible();
  await expect(sheet.getByText("Latte")).toBeVisible();

  await sheet.getByLabel("WhatsApp marketing").click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Record consent" }).click();
  await expect.poll(async () => ((await (await request.get(`${API}/customers`, { headers: s.auth })).json()) as { consents: { channel: string; granted: boolean }[] }[])[0].consents.find((k) => k.channel === "whatsapp")?.granted).toBe(true);
  await expect(sheet.getByLabel("WhatsApp marketing")).toBeChecked(); // the list reloaded with the new consent
  await sheet.getByLabel("WhatsApp marketing").click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Withdraw consent" }).click();
  await expect.poll(async () => ((await (await request.get(`${API}/customers`, { headers: s.auth })).json()) as { consents: { channel: string; granted: boolean }[] }[])[0].consents.at(-1)?.granted).toBe(false);

  const [h] = await Promise.all([page.waitForEvent("download"), sheet.getByRole("button", { name: "Export CSV" }).click()]);
  expect(h.suggestedFilename()).toBe("Sam-Regular-history.csv");
  expect((await readFile((await h.path())!, "utf8")).replace(/^﻿/, "")).toMatch(/^Invoice,Date,Total,Items\r\nINV[-/]/);
  await page.keyboard.press("Escape");

  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export CSV" }).click()]);
  expect(dl.suggestedFilename()).toBe("customers.csv");
  const csv = (await readFile((await dl.path())!, "utf8")).replace(/^﻿/, "");
  expect(csv.split("\r\n")[0]).toBe("Name,Phone,Email,Visits,Spent,Last visit,WhatsApp consent,SMS consent,Email consent");
  expect(csv).toContain("Sam Regular,'+919876500444"); // a leading + is neutralised like any formula start
});

test("CSV export neutralises spreadsheet formulas in customer names", async ({ page, request }) => {
  const s = await seed(request);
  await mk(request, s, "=HYPERLINK(\"http://evil\")", "+919876500555");
  await openAs(page, s.token, "/manage?tab=customers", s.refresh);
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export CSV" }).click()]);
  const csv = (await readFile((await dl.path())!, "utf8")).replace(/^﻿/, "");
  expect(csv).toContain(`"'=HYPERLINK`);
});

test("empty, error and read-only states", async ({ page, request }) => {
  const s = await seed(request);
  await openAs(page, s.token, "/manage?tab=customers", s.refresh);
  await expect(page.getByText("No customers yet")).toBeVisible();
  await page.getByRole("button", { name: "Add your first customer" }).click();
  await expect(page.getByRole("dialog", { name: "New customer" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.route("**/customers*", (route) => (route.request().method() === "GET" ? route.fulfill({ status: 500, json: { detail: "CRM is down" } }) : route.continue()));
  await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: "CRM is down" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});

test("without crm.write the list is read-only", async ({ page, request }) => {
  const s = await seed(request);
  await mk(request, s, "Sam Regular", "+919876500666");
  await page.route("**/auth/me", async (route) => {
    const res = await route.fetch(); const me = await res.json();
    me.permissions = (me.permissions as string[]).filter((p) => p !== "crm.write");
    await route.fulfill({ response: res, json: me });
  });
  await openAs(page, s.token, "/manage?tab=customers", s.refresh);
  await expect(page.getByRole("button", { name: "Sam Regular, open details" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New customer" })).toHaveCount(0);
  await page.getByRole("button", { name: "Sam Regular, open details" }).click();
  const sheet = page.getByRole("dialog", { name: "Sam Regular" });
  await expect(sheet.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(sheet.getByLabel("WhatsApp marketing")).toBeDisabled();
});
