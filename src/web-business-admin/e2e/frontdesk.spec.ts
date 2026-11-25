import { expect, test } from "@playwright/test";
import { API, openAs, seedIn } from "./helpers";

/** "YYYY-MM-DD" and "HH:MM" in India, `min` minutes from now. */
function istIn(min: number) {
  const d = new Date(Date.now() + min * 60_000 + 330 * 60_000);
  return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16) };
}

test("reservation: book with availability, table shows Reserved, seat opens the table at the counter", async ({ page, request }) => {
  const s = await seedIn(request);
  await openAs(page, s.token, "/reservations", s.refresh);
  await expect(page.getByText("No bookings for this day")).toBeVisible();
  await page.getByRole("button", { name: "New reservation" }).first().click();
  const sheet = page.getByRole("dialog", { name: "New reservation" });
  const at = istIn(30);
  await sheet.getByLabel("Guest name").fill("Asha Verma");
  await sheet.getByLabel("Mobile number").fill("98765 43210");
  await sheet.getByLabel("Guests").fill("2");
  await sheet.getByLabel("Date").fill(at.date);
  await sheet.getByLabel("Time").fill(at.time);
  await expect(sheet.getByTestId("availability")).toContainText("free for 2");
  await sheet.getByLabel("Table (optional)").selectOption({ label: "T1 · 4 seats" });
  await sheet.getByRole("button", { name: "Book table" }).click();
  const list = page.getByTestId("reservations");
  await expect(list).toContainText("Asha Verma");
  await expect(list).toContainText("Booked");
  await expect(list).toContainText("Table T1");
  // WhatsApp is off for a new restaurant: Remind is disabled and says why
  await expect(list.getByRole("button", { name: "Remind" })).toBeDisabled();
  await expect(list.getByTestId("remind-why")).toContainText("WhatsApp");

  // the floor shows the table as Reserved (booking within the hour)
  await page.goto("/manage?tab=tables");
  await expect(page.getByRole("button", { name: /T1/ }).first()).toContainText("Reserved");
  await expect(page.getByTestId("reserved-for")).toContainText("Asha Verma");

  // seat -> the order opens at the counter on table T1
  await page.goto(`/reservations`);
  await page.getByTestId("reservations").getByRole("button", { name: "Seat" }).click();
  await expect(page).toHaveURL(/\/pos/);
  const panel = page.getByRole("complementary", { name: "Current order" });
  await expect(panel.getByTestId("ticket-badge")).toContainText("T1");
  // add a dish to the seated table's order
  await page.getByRole("button", { name: /^Paneer Tikka,/ }).first().click();
  await panel.getByRole("button", { name: "Add to order" }).click();
  await expect(panel.getByTestId("more-items")).toHaveCount(0);
  const rs = (await (await request.get(`${API}/reservations?date=${at.date}`, { headers: s.auth })).json()) as { status: string; order_id: string }[];
  expect(rs[0].status).toBe("seated");
  const order = ((await (await request.get(`${API}/orders`, { headers: s.auth })).json()) as { id: string; lines: unknown[] }[]).find((o) => o.id === rs[0].order_id);
  expect(order?.lines.length).toBe(1);
});

test("clock in and out from the header; the manager sees the record, the report and the CSV", async ({ page, request }) => {
  const s = await seedIn(request);
  await openAs(page, s.token, "/manage", s.refresh);
  await page.getByRole("button", { name: "Clock in/out" }).click();
  let dlg = page.getByRole("dialog", { name: "Clock in/out" });
  await expect(dlg).toContainText("You are not clocked in");
  await dlg.getByTestId("clock-action").click();
  await expect(page.getByText(/Clocked in at/)).toBeVisible();
  await page.getByRole("button", { name: "Clock in/out" }).click();
  dlg = page.getByRole("dialog", { name: "Clock in/out" });
  await expect(dlg).toContainText("Clocked in since");
  await page.goto("/attendance");
  await expect(page.getByTestId("clocked-in")).toContainText("Owner");
  await page.getByRole("button", { name: "Clock in/out" }).click();
  await page.getByRole("dialog", { name: "Clock in/out" }).getByTestId("clock-action").click();
  await expect(page.getByText(/Clocked out/)).toBeVisible();

  await page.getByRole("tab", { name: "Records" }).click();
  await expect(page.getByTestId("attendance-records")).toContainText("Owner");
  await page.getByRole("tab", { name: "Report" }).click();
  await expect(page.getByTestId("attendance-report")).toContainText("Owner");
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download CSV" }).click();
  expect((await dl).suggestedFilename()).toMatch(/^attendance_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/);
  const recs = (await (await request.get(`${API}/attendance/records`, { headers: s.auth })).json()) as { open: boolean }[];
  expect(recs).toHaveLength(1);
  expect(recs[0].open).toBe(false);
});

test("setup checklist on Manage > Overview: progress, skip / undo, deep link, dismiss", async ({ page, request }) => {
  const s = await seedIn(request);
  await openAs(page, s.token, "/manage", s.refresh);
  const card = page.getByTestId("setup-card");
  await expect(card).toContainText("Finish setting up");
  await expect(card.getByTestId("setup-step-tables")).toContainText("(done)");
  await card.getByRole("button", { name: /^Skip .*printer/i }).click();
  await expect(card.getByTestId("setup-step-printer")).toContainText("(skipped)");
  await card.getByRole("button", { name: /^Undo skip .*printer/i }).click();
  await expect(card.getByTestId("setup-step-printer")).toContainText("(to do)");
  await card.getByTestId("setup-step-staff").getByRole("link").click();
  await expect(page).toHaveURL(/tab=staff/);
  await page.goto("/manage");
  await page.getByRole("button", { name: "Hide setup checklist" }).click();
  await expect(page.getByTestId("setup-card")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("today-tiles")).toBeVisible();
  await expect(page.getByTestId("setup-card")).toHaveCount(0);
});
