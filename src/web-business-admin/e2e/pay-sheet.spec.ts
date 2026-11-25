import { expect, test, type Page } from "@playwright/test";
import { bills, openPaySheet, openPos, seed } from "./helpers";

type Payment = { method: string; amount: string };
const payments = async (request: Parameters<typeof bills>[0], s: Parameters<typeof bills>[1]) =>
  ((await bills(request, s))[0] as unknown as { payments: Payment[]; total: string }).payments;

async function toBill(page: Page) {
  await page.getByRole("button", { name: /Latte/ }).first().click();
  await page.getByRole("button", { name: "Place order" }).click();
  await page.getByRole("button", { name: "Make bill" }).click();
  await expect(page.getByRole("button", { name: "Pay cash" })).toBeVisible();
}
const keys = async (page: Page, digits: string) => { for (const d of digits) await page.getByRole("group", { name: "Amount keypad" }).getByRole("button", { name: d === "." ? "Decimal point" : d, exact: true }).click(); };

test("one tap: Cash pays exactly the balance due (the original counter flow), with a toast", async ({ page, request }) => {
  const s = await seed(request);
  await openPos(page, s.token);
  await toBill(page);
  const row = page.getByTestId("pay-row");
  await expect(row.getByRole("button")).toHaveCount(3);          // Cash, Card, UPI on one row
  await page.getByRole("button", { name: "Pay cash" }).click();
  await expect(page.getByRole("button", { name: "New order" })).toBeVisible();
  await expect(page.getByText(/^Paid .* in cash$/)).toBeVisible();
  const [b] = (await bills(request, s)) as unknown as { payments: Payment[]; total: string; balance_due: string }[];
  expect(b.payments).toHaveLength(1);
  expect(b.payments[0].method).toBe("cash");
  expect(Number(b.payments[0].amount)).toBe(Number(b.total));
  expect(Number(b.balance_due)).toBe(0);
});

test("one tap: Card pays the exact balance by card", async ({ page, request }) => {
  const s = await seed(request);
  await openPos(page, s.token);
  await toBill(page);
  await page.getByRole("button", { name: "Pay card" }).click();
  await expect(page.getByRole("button", { name: "New order" })).toBeVisible();
  const p = await payments(request, s);
  expect(p.map((x) => x.method)).toEqual(["card"]);
});

test("pay sheet (Other amount / split): nothing is booked before Confirm; cash over the balance shows the change due", async ({ page, request }) => {
  const s = await seed(request);
  await openPos(page, s.token);
  await toBill(page);
  await openPaySheet(page);
  expect(await payments(request, s)).toHaveLength(0);          // opening the sheet books nothing
  await keys(page, "100");
  await expect(page.getByTestId("change-due")).toBeVisible();
  await page.getByRole("button", { name: /^Confirm payment/ }).click();
  await expect(page.getByRole("button", { name: "New order" })).toBeVisible();
  const p = await payments(request, s);
  expect(p).toHaveLength(1);
  expect(p[0].method).toBe("cash");                            // booked the amount due, not the 100 handed over
  expect(Number(p[0].amount)).toBeLessThan(100);
});

test("pay sheet (Other amount / split): split between cash and UPI sums to the balance", async ({ page, request }) => {
  const s = await seed(request);
  await openPos(page, s.token);
  await toBill(page);
  await openPaySheet(page);
  await keys(page, "5");
  await page.getByRole("button", { name: /and split the rest/ }).click();
  await page.getByRole("radio", { name: "UPI" }).click();
  await page.getByRole("button", { name: /^Confirm payment/ }).click();
  await expect(page.getByRole("button", { name: "New order" })).toBeVisible();
  const [b] = (await bills(request, s)) as unknown as { payments: Payment[]; total: string; balance_due: string }[];
  expect(b.payments.map((x) => x.method).sort()).toEqual(["cash", "upi"]);
  expect(Number(b.payments.find((x) => x.method === "cash")!.amount)).toBe(5);
  expect(Number(b.balance_due)).toBe(0);
});

test("pay sheet (Other amount / split): card cannot exceed the balance and Confirm stays disabled", async ({ page, request }) => {
  const s = await seed(request);
  await openPos(page, s.token);
  await toBill(page);
  await openPaySheet(page);
  await page.getByRole("radio", { name: "Card" }).click();
  await keys(page, "999");
  await expect(page.getByRole("alert").filter({ hasText: "cannot give change" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Confirm payment/ })).toBeDisabled();
});

test("phone counter: cart sheet has no title bar, and Cash / Card / UPI sit on one row", async ({ page, request }) => {
  const s = await seed(request);
  await page.setViewportSize({ width: 390, height: 844 });
  await openPos(page, s.token);
  await page.getByRole("button", { name: /Latte/ }).first().click();
  await page.getByRole("button", { name: /View order/ }).click();
  const sheet = page.getByRole("dialog", { name: "Current order" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText("Current order", { exact: true })).toHaveClass(/ch-sr-only/);   // accessible name only, no visible bar
  await expect(page.getByRole("button", { name: /View order/ })).toHaveCount(0);                // the floating bar steps aside
  await sheet.getByRole("button", { name: "Place order" }).click();
  await sheet.getByRole("button", { name: "Make bill" }).click();
  const row = sheet.getByTestId("pay-row").getByRole("button");
  await expect(row).toHaveCount(3);
  const boxes = await Promise.all([0, 1, 2].map(async (i) => (await row.nth(i).boundingBox())!));
  expect(new Set(boxes.map((b) => Math.round(b.y))).size).toBe(1);
  for (const b of boxes) expect(b.height).toBeLessThan(72);                                   // labels never wrap onto two lines
  await row.first().click();
  await expect(sheet.getByRole("button", { name: "New order" })).toBeVisible();
});
