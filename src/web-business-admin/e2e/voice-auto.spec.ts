import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API, fakeSpeech, openMenuPos, say, seedMenu, type MenuSeed } from "./helpers";

// Order type + table by voice (hands-free "Hey Zonov" is covered by voice-wake.spec.ts).
// SpeechRecognition is faked; nothing reaches the ticket before "Add to order".

interface OrderRow { order_type: string; table_id: string | null; customer_id: string | null; lines: { item_id: string; quantity: number }[] }
const orders = async (request: APIRequestContext, s: MenuSeed) => (await (await request.get(`${API}/orders`, { headers: s.auth })).json()) as OrderRow[];
const mk = async (request: APIRequestContext, s: MenuSeed, label: string, area: "indoor" | "outdoor") =>
  (await (await request.post(`${API}/tables`, { headers: s.auth, data: { label, area } })).json()).id as string;

const mic = (page: Page) => page.getByRole("button", { name: /^Voice order/ });

// ------------------------------------------------------------------ order type + table by voice

test("dine in table T3 + name + number + items: the order is created as indoor on T3", async ({ page, request }) => {
  const s = await seedMenu(request, { serviceCharge: null });
  const t3 = await mk(request, s, "T3", "indoor");
  await mk(request, s, "O2", "outdoor");
  await fakeSpeech(page);
  await openMenuPos(page, s);
  await expect(page.getByRole("radio", { name: "Takeaway" })).toHaveAttribute("aria-checked", "true"); // new tickets start as takeaway

  await mic(page).click();
  const dlg = page.getByRole("dialog", { name: "Listening" });
  await say(page, "final", "dine in table T3 customer name Raj number 098765 00123 do lamb karahi ek garlic naan");
  await expect(dlg.getByTestId("voice-line")).toHaveCount(2);
  // pre-selected on the sheet, not an optional extra
  await expect(dlg.getByLabel("Order type")).toHaveValue("indoor");
  await expect(dlg.getByLabel("Table")).toHaveText(/T3/);
  await expect(dlg.getByTestId("voice-table-hint")).toHaveCount(0);
  await expect(dlg.getByLabel("Customer name")).toHaveValue("Raj");
  await dlg.getByRole("button", { name: "Stop" }).click();
  const sheet = page.getByRole("dialog", { name: "Check the order" });
  await sheet.getByRole("button", { name: /^Add to order/ }).click();

  // once the table is chosen, type + table fold into one row on the order panel (audit C-05)
  await expect(page.getByTestId("table-chosen")).toContainText("Dine-in");
  await expect(page.getByRole("group", { name: "Table" }).getByRole("button", { name: /T3/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("ticket-badge")).toHaveText("Dine-in · T3");
  await expect(page.getByRole("tab", { name: /^Bill 1, Dine-in · T3,/ })).toBeVisible();
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.getByRole("button", { name: "Make bill" })).toBeVisible();
  const [o] = await orders(request, s);
  expect([o.order_type, o.table_id]).toEqual(["indoor", t3]);
  expect(o.customer_id).not.toBeNull();
});

test("outdoor O2: the table's area decides the type, and staff can change it on the sheet", async ({ page, request }) => {
  const s = await seedMenu(request, { serviceCharge: null });
  await mk(request, s, "T3", "indoor");
  const o2 = await mk(request, s, "O2", "outdoor");
  await fakeSpeech(page);
  await openMenuPos(page, s);
  await mic(page).click();
  const dlg = page.getByRole("dialog", { name: "Listening" });
  await say(page, "final", "dine in table O2 ek coke");
  await expect(dlg.getByLabel("Order type")).toHaveValue("outdoor"); // "dine in" + an outdoor table = outdoor
  await expect(dlg.getByLabel("Table")).toHaveText(/O2/);
  // staff: switch to takeaway on the sheet -> the table goes away
  await dlg.getByLabel("Order type").selectOption("takeaway");
  await expect(dlg.getByLabel("Table")).toHaveCount(0);
  await dlg.getByLabel("Order type").selectOption("outdoor");
  await expect(dlg.getByTestId("voice-table-hint")).toBeVisible(); // the table was cleared: choose again
  await dlg.getByLabel("Table").selectOption({ label: "O2" });
  await dlg.getByRole("button", { name: /^Add to order/ }).click();
  await expect(page.getByTestId("ticket-badge")).toHaveText("Outdoor · O2");
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.getByRole("button", { name: "Make bill" })).toBeVisible();
  const [o] = await orders(request, s);
  expect([o.order_type, o.table_id]).toEqual(["outdoor", o2]);
});

test("dine in with no table: dine-in is selected, the sheet says choose a table, placing waits for one", async ({ page, request }) => {
  const s = await seedMenu(request, { serviceCharge: null });
  const t3 = await mk(request, s, "T3", "indoor");
  await fakeSpeech(page);
  await openMenuPos(page, s);
  await mic(page).click();
  const dlg = page.getByRole("dialog", { name: "Listening" });
  await say(page, "final", "andar baithenge do garlic naan");
  await expect(dlg.getByLabel("Order type")).toHaveValue("indoor");
  await expect(dlg.getByTestId("voice-table-hint")).toContainText("needs a table");
  await dlg.getByRole("button", { name: /^Add to order/ }).click();
  await expect(page.getByRole("radio", { name: "Dine-in" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("Choose a table to place this order.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Place order" })).toBeDisabled();
  await page.getByRole("group", { name: "Table" }).getByRole("button", { name: /T3/ }).click();
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.getByRole("button", { name: "Make bill" })).toBeVisible();
  expect((await orders(request, s))[0].table_id).toBe(t3);
});

test("a spoken type is applied by default but staff can untick it (keep the ticket's type)", async ({ page, request }) => {
  // Delivery is a kitchen order type (business types): a restaurant + cloud kitchen has it, a plain restaurant does not.
  const s = await seedMenu(request, { serviceCharge: null, businessTypes: ["restaurant", "cloud_kitchen"] });
  await fakeSpeech(page);
  await openMenuPos(page, s);
  await mic(page).click();
  const dlg = page.getByRole("dialog", { name: "Listening" });
  await say(page, "final", "delivery 2 coke");
  await expect(dlg.getByLabel("Order type")).toHaveValue("delivery");
  await dlg.getByLabel("Order type").selectOption("");
  await dlg.getByRole("button", { name: /^Add to order/ }).click();
  await expect(page.getByRole("radio", { name: "Takeaway" })).toHaveAttribute("aria-checked", "true");
  await mic(page).click();
  await say(page, "final", "delivery 1 coke");
  await page.getByRole("dialog", { name: "Listening" }).getByRole("button", { name: /^Add to order/ }).click();
  await expect(page.getByRole("radio", { name: "Delivery" })).toHaveAttribute("aria-checked", "true");
});
