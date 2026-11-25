import { expect, test, type Page } from "@playwright/test";
import { API, openAs, seedIn } from "./helpers";

// Modifier groups and offers end to end, built through the admin screens, then used at the counter. The original counter tap
// count must not change: a plain dish is 1 tap to add + 1 to place; a dish whose required group has a default is the same.

/** Counts real taps (pointer clicks) on the page. */
async function tapCounter(page: Page) {
  await page.evaluate(() => { (window as unknown as { __taps: number }).__taps = 0; document.addEventListener("click", (e) => { if (e.isTrusted) (window as unknown as { __taps: number }).__taps++; }, true); });
  return () => page.evaluate(() => (window as unknown as { __taps: number }).__taps);
}

test("modifier group -> attached to a dish -> counter order with options, no extra tap", async ({ page, request }) => {
  const s = await seedIn(request);
  await openAs(page, s.token, "/modifiers", s.refresh);
  await page.getByRole("button", { name: "Add group" }).first().click();
  const sheet = page.getByRole("dialog", { name: "Add modifier group" });
  await sheet.getByLabel("Group name").fill("Spice level");
  await sheet.getByLabel("Minimum to pick").fill("1");
  await sheet.getByLabel("Maximum to pick").fill("1");
  await sheet.getByRole("button", { name: "Add option" }).click();
  const rows = sheet.getByTestId("option-row");
  for (const [i, [name, rupees]] of [["Mild", "0"], ["Medium", "0"], ["Hot", "20"]].entries()) {
    await rows.nth(i).getByLabel(`Option ${i + 1} name`).fill(name);
    await rows.nth(i).getByLabel("Price change ₹").fill(rupees);
  }
  await rows.nth(1).getByLabel("Default (picked automatically)").check();
  await sheet.getByRole("button", { name: "Add group" }).click();
  await expect(page.getByTestId("modifier-groups")).toContainText("Spice level");
  await expect(page.getByTestId("modifier-groups")).toContainText("Required · choose 1");

  // attach it in the item editor
  await page.goto("/manage?tab=menu");
  await page.getByRole("button", { name: "Edit Paneer Tikka" }).first().click();
  const editor = page.getByRole("dialog");
  await editor.getByTestId("item-modifier-groups").getByLabel(/Spice level/).check();
  await editor.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(async () => ((await (await request.get(`${API}/menu/items`, { headers: s.auth })).json()) as { id: string; modifier_group_ids: string[] }[]).find((i) => i.id === s.itemId)?.modifier_group_ids.length).toBe(1);

  // counter: ONE tap adds it with the default (no dialog), the line shows "Medium"
  await page.goto("/pos");
  const taps = await tapCounter(page);
  await page.getByRole("button", { name: /^Paneer Tikka,/ }).first().click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const panel = page.getByRole("complementary", { name: "Current order" });
  await expect(panel.getByText("Medium", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: /Place order/ }).click();
  await expect(panel.getByTestId("order-line")).toContainText("Order placed");
  expect(await taps(), "add + place = the original 2 taps").toBe(2);
  const orders = (await (await request.get(`${API}/orders`, { headers: s.auth })).json()) as { lines: { unit_price: string; modifiers: { name: string }[] }[] }[];
  expect(orders[0].lines[0].modifiers.map((m) => m.name)).toEqual(["Medium"]);

  // a second bill: change the option on the cart line to Hot (+₹20)
  await page.getByRole("button", { name: "New" }).first().click();
  await page.getByRole("button", { name: /^Paneer Tikka,/ }).first().click();
  await panel.getByRole("button", { name: "Change options for Paneer Tikka" }).click();
  const picker = page.getByRole("dialog", { name: "Paneer Tikka" });
  await picker.getByRole("button", { name: /^Hot/ }).click();
  await picker.getByTestId("picker-confirm").click();
  await expect(panel.getByText("Hot", { exact: true })).toBeVisible();
  await expect(panel.getByText("₹270.00 × 1")).toBeVisible();
  await panel.getByRole("button", { name: /Place order/ }).click();
  await expect(panel.getByTestId("order-line")).toContainText("Order placed");
  const all = (await (await request.get(`${API}/orders`, { headers: s.auth })).json()) as { lines: { unit_price: string; modifiers: { name: string }[] }[] }[];
  const hot = all.flatMap((o) => o.lines).find((l) => l.modifiers?.some((m) => m.name === "Hot"));
  expect(hot?.unit_price).toBe("270.00");
});

test("offer created on the Offers page applies by itself at the counter; a manager can take it off", async ({ page, request }) => {
  const s = await seedIn(request);
  await openAs(page, s.token, "/offers", s.refresh);
  await page.getByRole("button", { name: "Add offer" }).first().click();
  const sheet = page.getByRole("dialog", { name: "Add offer" });
  await sheet.getByLabel("Offer name").fill("Lunch 10%");
  await sheet.getByLabel("Discount %").fill("10");
  await sheet.getByRole("button", { name: "Add offer" }).click();
  await expect(page.getByTestId("offers")).toContainText("10% off the bill");
  await expect(page.getByTestId("active-offers")).toContainText("Offer: Lunch 10%");

  await page.goto("/pos");
  const taps = await tapCounter(page);
  await page.getByRole("button", { name: /^Paneer Tikka,/ }).first().click();
  const panel = page.getByRole("complementary", { name: "Current order" });
  // estimate (draft) already shows the offer line
  await expect(panel.getByTestId("offer-row")).toContainText("Offer: Lunch 10%");
  await expect(panel.getByTestId("offer-row")).toContainText("₹25.00");
  await panel.getByRole("button", { name: /Place order/ }).click();
  await expect(panel.getByTestId("totals")).toHaveAttribute("data-source", "server");
  await expect(panel.getByTestId("offer-row")).toContainText("₹25.00");
  expect(await taps()).toBe(2);

  // the owner sees the small switch; off -> the line goes, on -> it comes back
  const sw = panel.getByTestId("apply-offers").getByRole("switch", { name: "Apply offers" });
  await sw.uncheck();
  await expect(panel.getByTestId("offer-row")).toHaveCount(0);
  await sw.check();
  await expect(panel.getByTestId("offer-row")).toHaveCount(1);
  await panel.getByRole("button", { name: "Make bill" }).click();
  await expect(panel.getByRole("button", { name: /Cash/ }).first()).toBeVisible();
  const bills = (await (await request.get(`${API}/bills`, { headers: s.auth })).json()) as { offer_amount: string; discount_reason: string | null }[];
  expect(bills[0].offer_amount).toBe("25.00");
  expect(bills[0].discount_reason).toContain("Offer: Lunch 10%");
});
