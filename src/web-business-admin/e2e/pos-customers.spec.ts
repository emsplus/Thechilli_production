import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { payCash, API, openMenuPos, seedMenu, type MenuSeed } from "./helpers";

// Customers from the till (Indian restaurant): add inline from the picker (name and phone each optional), duplicate phone
// selects the existing customer, attach / change after the order is placed, and "Save as customer" on WhatsApp.

interface Cust { id: string; name: string | null; phone: string | null; display_name: string }
const dish = (page: Page, name: string) => page.getByRole("button", { name: new RegExp(`^${name},`) });
const customers = async (request: APIRequestContext, s: MenuSeed) => (await (await request.get(`${API}/customers`, { headers: s.auth })).json()) as Cust[];
const orders = async (request: APIRequestContext, s: MenuSeed) => (await (await request.get(`${API}/orders`, { headers: s.auth })).json()) as { id: string; customer_id: string | null; client_uuid: string }[];
const billsRaw = async (request: APIRequestContext, s: MenuSeed) => (await (await request.get(`${API}/bills`, { headers: s.auth })).json()) as { customer_name: string | null; customer_phone: string | null; invoice_number: string }[];

async function openPicker(page: Page) {
  await page.getByRole("button", { name: "Add customer (optional)" }).click();
  const dlg = page.getByRole("dialog", { name: "Choose a customer" });
  await expect(dlg).toBeVisible();
  return dlg;
}

test("new customer from the POS picker: Indian mobile stored as +91, selected on the ticket and printed on the bill", async ({ page, request }) => {
  const s = await seedMenu(request, { serviceCharge: null });
  await openMenuPos(page, s);
  await dish(page, "Lamb Karahi").click();

  // search finds nothing -> "Add '<typed>' as a new customer" with the phone prefilled
  const dlg = await openPicker(page);
  await dlg.getByLabel("Search customers").fill("098765 00123");
  await dlg.getByRole("button", { name: "Add ‘098765 00123’ as a new customer" }).click();
  const form = page.getByRole("dialog", { name: "New customer" });
  await expect(form.getByLabel("Phone")).toHaveValue("098765 00123");
  await expect(form.getByLabel("Name")).toBeFocused();
  await form.getByLabel("Name").fill("Priya Sharma");
  await form.getByLabel("Name").press("Enter"); // keyboard: Enter saves
  await expect(page.getByText("Priya Sharma added")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Customer: Priya Sharma/ })).toBeVisible();
  const list = await customers(request, s);
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ name: "Priya Sharma", phone: "+919876500123" });

  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.getByRole("button", { name: "Make bill" })).toBeVisible();
  expect((await orders(request, s))[0].customer_id).toBe(list[0].id);
  await page.getByRole("button", { name: "Make bill" }).click();
  await expect(page.getByText(/INV[-/]\d{4}[-/]000001/).first()).toBeVisible();
  const [bill] = await billsRaw(request, s);
  expect([bill.customer_name, bill.customer_phone]).toEqual(["Priya Sharma", "+919876500123"]);
});

test("name only or phone only are enough; neither is refused; a typed name prefills the name field", async ({ page, request }) => {
  const s = await seedMenu(request, { serviceCharge: null });
  await openMenuPos(page, s);
  await dish(page, "Coke").click();

  let dlg = await openPicker(page);
  await dlg.getByLabel("Search customers").fill("Walk-in Ravi");
  await dlg.getByLabel("Search customers").press("Enter"); // no match + Enter -> new customer form
  let form = page.getByRole("dialog", { name: "New customer" });
  await expect(form.getByLabel("Name")).toHaveValue("Walk-in Ravi");
  await form.getByRole("button", { name: "Save and select" }).click();
  await expect(page.getByRole("button", { name: /^Customer: Walk-in Ravi/ })).toBeVisible();

  // swap to a phone-only customer: shown by its number
  await page.getByRole("button", { name: /^Customer: Walk-in Ravi/ }).click();
  dlg = page.getByRole("dialog", { name: "Choose a customer" });
  await dlg.getByRole("button", { name: "New customer" }).click();
  form = page.getByRole("dialog", { name: "New customer" });
  await form.getByRole("button", { name: "Save and select" }).click();
  await expect(form.getByRole("alert")).toContainText("Enter a name or a phone number");
  await form.getByLabel("Phone").fill("12");
  await form.getByRole("button", { name: "Save and select" }).click();
  await expect(form.getByText(/Enter a valid phone number/)).toBeVisible();
  await form.getByLabel("Phone").fill("098765 00456");
  await form.getByRole("button", { name: "Save and select" }).click();
  await expect(page.getByRole("button", { name: /^Customer: \+919876500456/ })).toBeVisible();

  const list = await customers(request, s);
  expect(list.map((c) => [c.name, c.phone, c.display_name]).sort()).toEqual([
    [null, "+919876500456", "+919876500456"], ["Walk-in Ravi", null, "Walk-in Ravi"]].sort());

  await page.getByRole("button", { name: "Place order" }).click();
  await page.getByRole("button", { name: "Make bill" }).click();
  await expect(page.getByText(/INV[-/]\d{4}[-/]000001/).first()).toBeVisible();
  const [bill] = await billsRaw(request, s);
  expect([bill.customer_name, bill.customer_phone]).toEqual([null, "+919876500456"]);
});

test("a phone that already exists selects the existing customer instead of adding a duplicate", async ({ page, request }) => {
  const s = await seedMenu(request, { serviceCharge: null });
  const r = await request.post(`${API}/customers`, { headers: s.auth, data: { name: "Ali Khan", phone: "+91 98765 00555" } });
  expect(r.status()).toBe(201);
  await openMenuPos(page, s);
  await dish(page, "Lamb Karahi").click();
  const dlg = await openPicker(page);
  await dlg.getByRole("button", { name: "New customer" }).click();
  const form = page.getByRole("dialog", { name: "New customer" });
  await form.getByLabel("Name").fill("Somebody Else");
  await form.getByLabel("Phone").fill("098765 00555");
  await form.getByRole("button", { name: "Save and select" }).click();
  await expect(page.getByText("Already a customer: Ali Khan — selected")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Customer: Ali Khan/ })).toBeVisible();
  const list = await customers(request, s);
  expect(list).toHaveLength(1);
  expect(list[0].name).toBe("Ali Khan");
});

test("customer can be attached and changed after the order is placed, until it is billed", async ({ page, request }) => {
  const s = await seedMenu(request, { serviceCharge: null });
  await request.post(`${API}/customers`, { headers: s.auth, data: { name: "Fatima Noor", phone: "098765 00111" } });
  await openMenuPos(page, s);
  await dish(page, "Lamb Karahi").click();
  await page.getByRole("button", { name: "Place order" }).click();
  await page.getByRole("button", { name: /Send to kitchen/ }).click();
  await expect(page.getByRole("button", { name: /Kitchen ticket #1 sent/ })).toBeVisible();
  const [o] = await orders(request, s);
  expect(o.customer_id).toBeNull();

  // attach an existing customer (search by the national number)
  let dlg = await openPicker(page);
  await dlg.getByLabel("Search customers").fill("09876500111");
  await dlg.getByRole("button", { name: /Fatima Noor/ }).click();
  await expect(page.getByRole("button", { name: /^Customer: Fatima Noor/ })).toBeVisible();
  const fatima = (await customers(request, s))[0];
  await expect.poll(async () => (await orders(request, s))[0].customer_id).toBe(fatima.id);

  // change it to a brand-new customer created right here
  await page.getByRole("button", { name: /^Customer: Fatima Noor/ }).click();
  dlg = page.getByRole("dialog", { name: "Choose a customer" });
  await dlg.getByRole("button", { name: "New customer" }).click();
  const form = page.getByRole("dialog", { name: "New customer" });
  await form.getByLabel("Name").fill("Imran Ali");
  await form.getByLabel("Phone").fill("+91 98765 00222");
  await form.getByRole("button", { name: "Save and select" }).click();
  await expect(page.getByRole("button", { name: /^Customer: Imran Ali/ })).toBeVisible();
  const imran = (await customers(request, s)).find((c) => c.name === "Imran Ali")!;
  await expect.poll(async () => (await orders(request, s))[0].customer_id).toBe(imran.id);

  // clear, then attach again
  await page.getByRole("button", { name: "Remove customer" }).click();
  await expect(page.getByRole("button", { name: "Add customer (optional)" })).toBeVisible();
  await expect.poll(async () => (await orders(request, s))[0].customer_id).toBeNull();
  dlg = await openPicker(page);
  await dlg.getByRole("button", { name: /Imran Ali/ }).click();
  await expect.poll(async () => (await orders(request, s))[0].customer_id).toBe(imran.id);

  await page.getByRole("button", { name: "Make bill" }).click();
  await expect(page.getByText(/INV[-/]\d{4}[-/]000001/).first()).toBeVisible();
  const [bill] = await billsRaw(request, s);
  expect([bill.customer_name, bill.customer_phone]).toEqual(["Imran Ali", "+919876500222"]);
  // billed: the customer is shown but no longer editable
  await expect(page.getByRole("button", { name: /^Customer: / })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add customer (optional)" })).toHaveCount(0);
  const late = await request.put(`${API}/orders/${o.id}/customer`, { headers: s.auth, data: { customer_id: fatima.id } });
  expect(late.status()).toBe(409);
});

test("offline: picking from the loaded list works, adding needs a connection, a queued order carries the customer", async ({ page, context, request }) => {
  const s = await seedMenu(request, { serviceCharge: null });
  await request.post(`${API}/customers`, { headers: s.auth, data: { name: "Zara Malik", phone: "098765 00333" } });
  await openMenuPos(page, s, { sw: true });
  await context.setOffline(true);
  await expect(page.getByTestId("conn")).toHaveText("Offline");
  await dish(page, "Lamb Karahi").click();
  await page.getByRole("button", { name: /Place order/ }).click();
  await expect(page.getByTestId("order-line")).toContainText("Saved offline");

  const dlg = await openPicker(page);
  await expect(dlg.getByRole("button", { name: "New customer" })).toBeDisabled();
  await expect(dlg.getByText("Adding a new customer needs a connection")).toBeVisible();
  await dlg.getByRole("button", { name: /Zara Malik/ }).click(); // rewrites the queued create_order, same client_uuid
  await expect(page.getByRole("button", { name: /^Customer: Zara Malik/ })).toBeVisible();
  expect(await orders(request, s)).toHaveLength(0);

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByTestId("pending-count")).toHaveCount(0, { timeout: 30_000 });
  const zara = (await customers(request, s))[0];
  const os = await orders(request, s);
  expect(os).toHaveLength(1);
  expect(os[0].customer_id).toBe(zara.id);
});

test("WhatsApp: 'Save this number as a customer' saves the customer before WhatsApp opens", async ({ page, context, request }) => {
  const s = await seedMenu(request, { serviceCharge: null });
  await context.route("https://wa.me/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "wa" }));
  await page.addInitScript(() => { Object.defineProperty(navigator, "canShare", { value: undefined, configurable: true }); });
  await openMenuPos(page, s);
  await dish(page, "Lamb Karahi").click();
  await page.getByRole("button", { name: "Place order" }).click();
  await page.getByRole("button", { name: "Make bill" }).click();
  await payCash(page);
  await expect(page.getByRole("button", { name: "New order" })).toBeVisible();

  await page.getByTestId("bill-actions").getByRole("button", { name: "Share on WhatsApp" }).click();
  const dlg = page.getByRole("dialog", { name: "Send bill on WhatsApp" });
  const save = dlg.getByLabel("Save this number as a customer");
  await expect(save).not.toBeChecked();
  await dlg.getByLabel("Customer mobile number").fill("98765 00777");
  await dlg.getByLabel("Customer name (optional)").fill("Rahul Verma");
  await expect(save).toBeChecked(); // typing a name ticks it
  const popupPromise = context.waitForEvent("page");
  await dlg.getByRole("button", { name: "Open WhatsApp" }).click();
  const popup = await popupPromise;
  await popup.waitForURL(/^https:\/\/wa\.me\/919876500777\?text=/);
  expect(decodeURIComponent(popup.url())).toContain("/api/v1/public/receipts/");
  const list = await customers(request, s);
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ name: "Rahul Verma", phone: "+919876500777" });
  const [bill] = await billsRaw(request, s);
  expect(bill.customer_name).toBeNull(); // the finalized bill never changes

  // the same number again: reuses the customer, sending is never blocked
  await popup.close();
  await page.getByTestId("bill-actions").getByRole("button", { name: "Share on WhatsApp" }).click();
  await dlg.getByLabel("Customer mobile number").fill("+91 98765 00777");
  await dlg.getByLabel("Save this number as a customer").check();
  const again = context.waitForEvent("page");
  await dlg.getByRole("button", { name: "Open WhatsApp" }).click();
  await (await again).waitForURL(/^https:\/\/wa\.me\/919876500777\?text=/);
  await expect(page.getByText("Already a customer: Rahul Verma")).toBeVisible();
  expect(await customers(request, s)).toHaveLength(1);
});
