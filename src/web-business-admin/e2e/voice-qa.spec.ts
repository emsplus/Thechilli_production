import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { openAs } from "./helpers";
import { apiSession, installHarness, qa, seedOwner, tickets, type ServerOrder } from "./voice-qa-harness";

// Voice QA key flows (docs/VOICE_QA_REPORT.md), real browser + real API, SpeechRecognition replaced by the scripted recogniser
// of voice-qa-harness.ts. Owner rules 2026-11: done / add to order = add only; place order / send to kitchen = add what is on
// the sheet, place, send the kitchen ticket, by themselves after a visible countdown; stop / ruko / nahi / Cancel abort.

const SHOTS = process.env.VOICE_QA_SHOTS ?? "docs/voice-qa-shots";
const panel = (page: Page) => page.getByRole("complementary", { name: "Current order" });
const mic = (page: Page) => page.getByRole("button", { name: /^Voice order/ });
const countdown = (page: Page) => page.getByTestId("voice-countdown");

async function setup(page: Page, context: BrowserContext, request: APIRequestContext, opts: { handsFree: boolean; countdown?: number; busyAfterCloseMs?: number }) {
  const m = await seedOwner(request);
  await context.grantPermissions(["microphone"]);
  await installHarness(page, { handsFree: opts.handsFree, silenceMs: 4000, busyAfterCloseMs: opts.busyAfterCloseMs });
  if (opts.countdown !== undefined) await page.addInitScript((n) => { localStorage.setItem("pos.voiceCountdown", String(n)); }, opts.countdown);
  await openAs(page, m.token, "/pos", m.refresh);
  await expect(page.getByRole("button", { name: /^Matar Paneer,/ }).first()).toBeVisible();
  if (opts.handsFree) await expect.poll(() => qa(page, "listening"), { timeout: 10_000 }).toBeGreaterThan(0);
  const srv = apiSession(request, m);
  await srv.login();
  return { m, orders: () => srv.get<ServerOrder[]>("/orders"), kots: () => srv.get<{ order_id: string }[]>("/kot") };
}

/** Speaks like Chrome: word-by-word interims, then the final. */
async function speak(page: Page, text: string) {
  const ws = text.split(" ");
  for (let k = 1; k < ws.length; k++) { await qa(page, "interim", ws.slice(0, k).join(" ")); await page.waitForTimeout(60); }
  await qa(page, "final", text);
}
const cartLines = async (page: Page) => (await tickets(page)).flatMap((t) => [...t.lines, ...t.more]).map((l) => `${l.name} x${l.qty}${l.check ? " (check)" : ""}`).sort();

test.use({ viewport: { width: 1280, height: 800 } });

test("the owner's demo: Hey Zonov, three dishes, done (cart to check, nothing placed), then place order -> countdown, placed AND sent, on the kitchen screen; no taps", async ({ page, context, request, browser }) => {
  const s = await setup(page, context, request, { handsFree: true });
  await speak(page, "hey Zonov one matar paneer, two lassi, four chapati, done");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText(/^Added 7 items to the cart/)).toBeVisible();
  await expect.poll(() => cartLines(page)).toEqual(["Matar Paneer x1", "Sweet Lassi x2", "Tandoori Roti x4"]);
  await expect(panel(page).getByText("Sweet Lassi", { exact: true })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/1-done-cart.png` });
  expect(await s.orders()).toHaveLength(0);
  expect(await s.kots()).toHaveLength(0);
  // "place order" right after, without the wake phrase (hands-free follow-up)
  await expect.poll(() => qa(page, "listening"), { timeout: 10_000 }).toBeGreaterThan(0);
  await speak(page, "place order");
  await expect(countdown(page)).toBeVisible();
  await expect(countdown(page)).toContainText(/Sending to the kitchen in 3, 2, 1\. Say “stop” or tap Cancel\./);
  await page.screenshot({ path: `${SHOTS}/2-countdown.png` });
  await expect.poll(async () => (await s.kots()).length, { timeout: 30_000 }).toBe(1);
  const o = await s.orders();
  expect(o).toHaveLength(1);
  expect(o[0].lines.map((l) => `${l.item_name} x${l.quantity}`).sort()).toEqual(["Matar Paneer x1", "Sweet Lassi x2", "Tandoori Roti x4"]);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("voice-outcome")).toHaveText(/sent to the kitchen/);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/3-sent.png` });
  expect((await s.kots()).length).toBe(1); // exactly once
  // the kitchen screen shows the ticket
  const k = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await openAs(k, s.m.token, "/kitchen", s.m.refresh);
  await expect(k.getByTestId("kitchen")).toBeVisible();
  await expect(k.getByText("Tandoori Roti").first()).toBeVisible();
  await expect(k.getByText("Sweet Lassi").first()).toBeVisible();
  await k.screenshot({ path: `${SHOTS}/4-kitchen.png` });
  await k.close();
});

test("one utterance: 'Hey Zonov, one matar paneer, two lassi, place order' = add + place + kitchen ticket, once, even with a duplicate final", async ({ page, context, request }) => {
  const s = await setup(page, context, request, { handsFree: true });
  await speak(page, "Hey Zonov, one matar paneer, two lassi, Place order.");
  await qa(page, "dup");
  await expect(countdown(page)).toBeVisible();
  await expect.poll(async () => (await s.kots()).length, { timeout: 30_000 }).toBe(1);
  await page.waitForTimeout(1500);
  expect(await s.orders()).toHaveLength(1);
  expect(await s.kots()).toHaveLength(1);
  await expect.poll(() => cartLines(page)).toEqual(["Matar Paneer x1", "Sweet Lassi x2"]);
});

test("placed at the counter, then 'Hey Zonov, send to kitchen' sends its kitchen ticket (no new dishes needed); again -> 'already in the kitchen'", async ({ page, context, request }) => {
  const s = await setup(page, context, request, { handsFree: true });
  await page.getByRole("button", { name: /^Matar Paneer,/ }).first().click();
  await panel(page).getByRole("button", { name: /^Place order/ }).click();
  await expect.poll(async () => (await s.orders()).length).toBe(1);
  expect(await s.kots()).toHaveLength(0);
  await expect.poll(() => qa(page, "listening"), { timeout: 10_000 }).toBeGreaterThan(0);
  await speak(page, "hey zonov send to kitchen");
  await expect(countdown(page)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/5-send-placed.png` });
  await expect.poll(async () => (await s.kots()).length, { timeout: 30_000 }).toBe(1);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => qa(page, "listening"), { timeout: 10_000 }).toBeGreaterThan(0);
  await speak(page, "hey zonov kitchen bhejo");
  await expect(page.getByText(/is already in the kitchen/).first()).toBeVisible({ timeout: 30_000 });
  expect(await s.kots()).toHaveLength(1);
});

test("'stop' during the countdown: nothing placed or sent, the dishes stay in the cart", async ({ page, context, request }) => {
  const s = await setup(page, context, request, { handsFree: false });
  await mic(page).click();
  await speak(page, "one matar paneer, three mango lassi, order place karo");
  await expect(countdown(page)).toBeVisible();
  await page.waitForTimeout(700);
  await qa(page, "final", "ruko");
  await expect(page.getByText(/Not sent to the kitchen: you said stop/)).toBeVisible();
  await expect.poll(() => cartLines(page)).toEqual(["Mango Lassi x3", "Matar Paneer x1"]);
  await page.waitForTimeout(4000);
  expect(await s.orders()).toHaveLength(0);
  expect(await s.kots()).toHaveLength(0);
});

test("Cancel tapped during the countdown works the same", async ({ page, context, request }) => {
  const s = await setup(page, context, request, { handsFree: false });
  await mic(page).click();
  await speak(page, "two dal makhani, send to kitchen");
  await expect(countdown(page)).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText(/Not sent to the kitchen: cancelled/)).toBeVisible();
  await page.waitForTimeout(4000);
  expect(await s.orders()).toHaveLength(0);
  await expect.poll(() => cartLines(page)).toEqual(["Dal Makhani x2"]);
});

test("an ambiguous dish never blocks: 'one biryani' gets a default with Check and Change; the countdown is 5 s and lists it", async ({ page, context, request }) => {
  const s = await setup(page, context, request, { handsFree: false });
  await mic(page).click();
  await speak(page, "one biryani, two lassi, place order");
  await expect(countdown(page)).toBeVisible();
  await expect(countdown(page)).toContainText("in 5, 4, 3, 2, 1");
  await expect(page.getByTestId("voice-countdown-checks")).toContainText(/1 × (Chicken|Mutton) Biryani/);
  await expect(page.getByRole("dialog").getByRole("combobox", { name: "Which dish for “one biryani”" })).toBeVisible(); // Change
  await page.screenshot({ path: `${SHOTS}/6-ambiguous-countdown.png` });
  const axe = await new AxeBuilder({ page }).include("[role=dialog]").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id), "axe on the countdown sheet").toEqual([]);
  await expect.poll(async () => (await s.kots()).length, { timeout: 30_000 }).toBe(1);
  const names = (await s.orders())[0].lines.map((l) => l.item_name).sort();
  expect(names).toEqual([expect.stringMatching(/^(Chicken|Mutton) Biryani$/), "Sweet Lassi"].sort());
});

test("a sold-out dish stays on the sheet with the reason, the rest is placed and sent", async ({ page, context, request }) => {
  const s = await setup(page, context, request, { handsFree: false });
  await mic(page).click();
  await speak(page, "one jeera rice, two lassi, send to kitchen");
  await expect.poll(async () => (await s.kots()).length, { timeout: 30_000 }).toBe(1);
  expect((await s.orders())[0].lines.map((l) => l.item_name)).toEqual(["Sweet Lassi"]);
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByTestId("voice-done-hold")).toContainText(/Jeera Rice/);
  await page.screenshot({ path: `${SHOTS}/7-sold-out-left.png` });
});

test("dine in without a table: the dishes go into the cart and it says to choose a table; nothing placed", async ({ page, context, request }) => {
  const s = await setup(page, context, request, { handsFree: false }); // the restaurant has table T1
  await mic(page).click();
  await speak(page, "dine in, one matar paneer, place order");
  await expect(page.getByText(/Not sent to the kitchen: choose a table for this dine-in order first/)).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => cartLines(page)).toEqual(["Matar Paneer x1"]);
  expect(await s.orders()).toHaveLength(0);
});

test("the command left unfinished (interim) when the recogniser ends after a pause still runs", async ({ page, context, request }) => {
  const s = await setup(page, context, request, { handsFree: false });
  await mic(page).click();
  await qa(page, "final", "two mango lassi");
  await qa(page, "interim", "place order");
  await qa(page, "end"); // Chrome ends the session; the app restarts the recogniser
  await expect(countdown(page)).toBeVisible();
  await expect.poll(async () => (await s.kots()).length, { timeout: 30_000 }).toBe(1);
  expect(await s.orders()).toHaveLength(1);
});

test("countdown setting 0: runs at once; 'add to order' only adds", async ({ page, context, request }) => {
  const s = await setup(page, context, request, { handsFree: false, countdown: 0 });
  await mic(page).click();
  await speak(page, "two tandoori roti, add to order");
  await expect.poll(() => cartLines(page)).toEqual(["Tandoori Roti x2"]);
  await page.waitForTimeout(1000);
  expect(await s.orders()).toHaveLength(0);
  await mic(page).click();
  await speak(page, "send to kitchen");
  await expect.poll(async () => (await s.kots()).length, { timeout: 8000 }).toBe(1);
  await expect(countdown(page)).toHaveCount(0);
});

test("'done' alone: Nothing to add yet (kept)", async ({ page, context, request }) => {
  await setup(page, context, request, { handsFree: false });
  await mic(page).click();
  await qa(page, "final", "done");
  await expect(page.getByText("Nothing to add yet")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

// Owner bug 2026-11-02: after a completed order (spoken place / send ran, order placed + KOT sent) "Hey Zonov" did nothing any
// more. The recogniser is Chrome-like here: one started right after another was stopped / aborted throws InvalidStateError.
test("20 orders in a row, each started with 'Hey Zonov': every one opens the sheet (after place, send, stop, Cancel, close, a refused place, a new bill)", async ({ page, context, request }) => {
  test.setTimeout(25 * 60_000);
  const s = await setup(page, context, request, { handsFree: true, busyAfterCloseMs: 400 });
  const endings = ["place order", "send to kitchen", "stop", "cancel-tap", "escape", "done", "dine-in-refused", "new-bill", "kitchen bhejo", "add to order"];
  let kots = 0;
  for (let n = 0; n < 20; n++) {
    const how = endings[n % endings.length];
    await expect.poll(() => qa(page, "listening"), { timeout: 30_000, message: `order ${n + 1} (${how}): hands-free listening again` }).toBeGreaterThan(0);
    await expect(page.getByTestId("auto-status"), `order ${n + 1}: waiting for the wake phrase`).toHaveText(/Waiting for “Hey Zonov”/, { timeout: 30_000 });
    await speak(page, "hey Zonov");
    await expect(page.getByRole("dialog"), `order ${n + 1} (${how}): Hey Zonov opens the sheet`).toBeVisible({ timeout: 15_000 });
    if (how === "escape") { await qa(page, "final", "two dal makhani"); await page.keyboard.press("Escape"); }
    else if (how === "cancel-tap") { await qa(page, "final", "one matar paneer, place order"); await expect(countdown(page)).toBeVisible({ timeout: 15_000 }); await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click(); }
    else if (how === "stop") { await qa(page, "final", "one matar paneer, send to kitchen"); await expect(countdown(page)).toBeVisible({ timeout: 15_000 }); await qa(page, "final", "ruko"); }
    else if (how === "dine-in-refused") { await qa(page, "final", "dine in, one matar paneer, place order"); }
    else if (how === "new-bill") { await qa(page, "final", "new bill, two tandoori roti, done"); }
    else if (how === "done" || how === "add to order") { await qa(page, "final", `one mango lassi, ${how}`); }
    else {
      await qa(page, "final", `one matar paneer, two lassi, ${how}`);
      kots++;
      await expect.poll(async () => (await s.kots()).length, { timeout: 40_000, message: `order ${n + 1}: sent` }).toBe(kots);
      // the next order starts on a fresh bill (the counter's New)
      await page.getByRole("button", { name: /^New/ }).first().dispatchEvent("click"); // (a busy machine kept the strip from settling for a real click)
    }
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
  }
});
