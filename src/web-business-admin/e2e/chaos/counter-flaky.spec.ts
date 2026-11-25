import { test } from "@playwright/test";
import { API, billsFull, dumpQueue, expect, log, openPos, resetAbuse, seed, shot, sleep, unsynced } from "./common";

/** Scenario 1: flaky network (toggle every 2-5 s) for CHAOS_MINUTES (default 5) while the counter keeps selling Latte: place -> KOT -> bill -> pay. */
const MINUTES = Number(process.env.CHAOS_MINUTES ?? 5);

test(`B4 counter flaky network ${MINUTES} min: every finished sale is on the server exactly once, paid exactly`, async ({ page, context, request }) => {
  test.setTimeout((MINUTES + 12) * 60_000);
  resetAbuse();
  const s = await seed(request);
  await openPos(page, s.token);
  let stop = false, offline = false, toggles = 0;
  const flapper = (async () => { while (!stop) { await sleep(2000 + Math.random() * 3000); offline = !offline; toggles++; await context.setOffline(offline).catch(() => {}); } })();
  let completed = 0; const errors: string[] = [];
  const end = Date.now() + MINUTES * 60_000;
  const btn = (n: RegExp | string) => page.getByRole("button", { name: n });
  while (Date.now() < end) {
    try {
      await page.getByRole("button", { name: /^Latte,/ }).first().click({ timeout: 15_000 }).catch(async () => { await page.getByRole("button", { name: /Latte/ }).first().click({ timeout: 15_000 }); });
      await btn(/Place order/).click({ timeout: 15_000 });
      // drive the ticket to its end whatever the network does meanwhile
      const until = Date.now() + 60_000; let done = false;
      while (Date.now() < until && !done) {
        if (await btn("New order").count() || await page.getByTestId("provisional").count()) { done = true; break; }
        else if (await btn("Make bill").count() && await btn("Make bill").isEnabled()) { await btn("Make bill").click({ timeout: 5000 }).catch(() => {}); }
        else if (await btn(/Send to kitchen/).count() && (await btn(/Send to kitchen/).first().isEnabled())) { await btn(/Send to kitchen/).first().click({ timeout: 5000 }).catch(() => {}); }
        else if (await btn("Pay cash").count()) { await btn("Pay cash").click({ timeout: 5000 }).catch(() => {}); }
        else if (await btn("Cash (offline)").count()) { await btn("Cash (offline)").click({ timeout: 5000 }).catch(() => {}); }
        await sleep(400);
      }
      if (!done) throw new Error("ticket did not finish in 60 s");
      completed++;
      if (completed % 5 === 0) await shot(page, `B4-${offline ? "offline" : "online"}-${completed}`);
      if (await btn("New order").count()) await btn("New order").click({ timeout: 5000 }).catch(() => {});
      else if (await btn("Start another order").count()) await btn("Start another order").click({ timeout: 5000 }).catch(() => {});
      else await page.keyboard.press("Escape");
    } catch (e) {
      errors.push(`completed=${completed} offline=${offline}: ${String(e).split("\n")[0]}`);
      log("B4.log", `ACTION ERROR ${errors[errors.length - 1]}`);
      await shot(page, `B4-error-${errors.length}`);
      await page.keyboard.press("Escape");
      if (errors.length > 12) break;
    }
    await sleep(200);
  }
  stop = true; await flapper; await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  log("B4.log", `toggles=${toggles} completed=${completed} actionErrors=${errors.length}`);
  await expect.poll(async () => (await unsynced(page)).length, { timeout: 180_000, intervals: [3000] }).toBe(0);
  const b = ((await billsFull(request, s)) as any[]).filter((x) => x.status === "active");
  const orders = await (await request.get(`${API}/orders`, { headers: s.auth })).json();
  const unpaid = b.filter((x) => Math.abs(Number(x.balance_due)) > 0.001);
  const multiPay = b.filter((x) => (x.payments as unknown[]).length !== 1);
  const badTotal = b.filter((x) => x.total !== "13.13");
  const kotBad = orders.filter((o: { kots: unknown[] }) => o.kots.length > 1);
  log("B4.log", `server: orders=${orders.length} bills=${b.length} unpaid=${unpaid.length} paymentsNot1=${multiPay.length} wrongTotal=${badTotal.length} ordersWithKotsNot1=${kotBad.length} invoice#unique=${new Set(b.map((x) => x.invoice_number)).size === b.length}`);
  log("B4.log", `queue left=${(await dumpQueue(page)).length}`);
  await shot(page, "B4-final");
  expect(b.length).toBeGreaterThanOrEqual(completed); // a ticket the cashier saw as finished must exist
  expect(orders.length).toBe(b.length);
  expect(unpaid).toHaveLength(0);
  expect(multiPay).toHaveLength(0);
  expect(badTotal).toHaveLength(0);
  expect(kotBad).toHaveLength(0);
});
