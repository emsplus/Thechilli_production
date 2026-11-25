import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API, fakeSpeech, openMenuPos, say, seedMenu, type MenuSeed } from "./helpers";

// The voice-language chip is hidden while the app is English only (NEXT_PUBLIC_ENABLE_LANGUAGES off): the tests that switch it need the flag.
const LANGS = process.env.NEXT_PUBLIC_ENABLE_LANGUAGES === "true" || process.env.NEXT_PUBLIC_ENABLE_LANGUAGES === "1";

// Hands-free "Hey Zonov": the till waits quietly (one background recogniser), opens the order sheet when it hears the wake
// phrase and takes only the words AFTER it. SpeechRecognition is faked. Nothing reaches the ticket before "Add to order".

const orders = async (request: APIRequestContext, s: MenuSeed) => (await (await request.get(`${API}/orders`, { headers: s.auth })).json()) as { order_type: string }[];
const mic = (page: Page) => page.getByRole("button", { name: /^Voice order/ });
const live = (page: Page) => page.evaluate(() => (window as unknown as { __live: () => number }).__live());
const made = (page: Page) => page.evaluate(() => (window as unknown as { __sr: unknown[] }).__sr.length);
const status = (page: Page) => page.getByTestId("auto-status");
const sheet = (page: Page) => page.getByRole("dialog", { name: "Listening" });
const tabs = (page: Page) => page.getByRole("tablist", { name: "Open orders" }).getByRole("tab");
const calls = (page: Page) => { const sent: string[] = []; void page.route("**/api/v1/ai/voice-order", (r) => { sent.push(r.request().url()); void r.abort(); }); return sent; };

async function waiting(page: Page, context: { grantPermissions: (p: string[]) => Promise<void> }, request: APIRequestContext, opts: { silenceMs?: number } = {}) {
  const s = await seedMenu(request, { serviceCharge: null });
  await context.grantPermissions(["microphone"]);
  await fakeSpeech(page, { handsFreeDefault: true });
  if (opts.silenceMs) await page.addInitScript((ms) => { (window as unknown as { __POS_VOICE_SILENCE_MS: number }).__POS_VOICE_SILENCE_MS = ms; }, opts.silenceMs);
  await openMenuPos(page, s);
  await expect(status(page)).toHaveText(/Waiting for “Hey Zonov”/);
  expect(await live(page)).toBe(1);
  return s;
}

const handsFree = (page: Page) => page.getByTestId("hands-free");

test("on by default with a visible 'Listening' switch: it waits quietly for Hey Zonov, says so honestly, and the mic presses itself", async ({ page, context, request }) => {
  const s = await seedMenu(request, { serviceCharge: null });
  await context.grantPermissions(["microphone"]);
  await fakeSpeech(page, { handsFreeDefault: true });
  await openMenuPos(page, s);
  await expect(handsFree(page)).toHaveAccessibleName("Hands-free “Hey Zonov”: Listening");
  await expect(handsFree(page)).toHaveAttribute("aria-pressed", "true");
  await expect(status(page)).toHaveText(/Waiting for “Hey Zonov”/);
  await expect(status(page)).toHaveText("Waiting for “Hey Zonov”"); // nothing else: no notes, no "heard" line
  await expect(mic(page)).toHaveAttribute("aria-label", "Voice order (waiting for Hey Zonov)");
  await expect(page.getByRole("dialog")).toHaveCount(0); // no sheet until the wake phrase
  // the mic button visibly presses itself when the phrase is heard
  await say(page, "final", "hey Zonov");
  await expect(sheet(page)).toBeVisible();
  await page.getByRole("button", { name: /^Cancel/ }).first().click();
  await expect(sheet(page)).toHaveCount(0);
});

test("speech before the wake phrase is ignored: no sheet, nothing parsed, nothing sent", async ({ page, context, request }) => {
  const sent = calls(page);
  const s = await waiting(page, context, request);
  await say(page, "final", "we need more ketchup, two lamb karahi on the pass, table five wants the bill");
  await say(page, "interim", "zonov");
  await page.waitForTimeout(800);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText(/ketchup/)).toHaveCount(0); // never shown anywhere
  await expect(status(page)).toHaveText(/Waiting for “Hey Zonov”/);
  expect(await live(page)).toBe(1);
  expect(sent).toHaveLength(0);
  expect(await orders(request, s)).toHaveLength(0);
});

test("\"Hey Zonov 2 coke\" in one breath opens the sheet with only the order words", async ({ page, context, request }) => {
  await waiting(page, context, request);
  await say(page, "final", "need ketchup");
  await say(page, "interim", "hey mo");
  await expect(page.getByRole("dialog")).toHaveCount(0); // half a wake phrase is not enough
  await say(page, "final", "hey Zonov 2 coke");
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).getByTestId("voice-woke")).toHaveText("Hey Zonov heard: listening…");
  await expect(sheet(page).getByTestId("voice-line")).toHaveCount(1);
  await expect(sheet(page).getByTestId("voice-line")).toContainText("Coke");
  await expect(sheet(page).getByTestId("voice-transcript")).toHaveText("2 coke"); // not the wake phrase, not the ketchup
  await expect(sheet(page).getByTestId("voice-unmatched")).toHaveCount(0);
  expect(await made(page)).toBe(1); // "Hey Zonov" acts like a tap on the mic, but the waiting recogniser keeps listening (no restart)
  expect(await live(page)).toBe(1); // ...and only one recogniser is listening
});

test("\"Hey Zonov\", a pause, then the order", async ({ page, context, request }) => {
  await waiting(page, context, request);
  await say(page, "final", "Hey Zonov");
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).getByTestId("voice-woke")).toBeVisible();
  await expect(sheet(page).getByTestId("voice-line")).toHaveCount(0);
  await expect(sheet(page).getByTestId("voice-unmatched")).toHaveCount(0); // the wake phrase itself is not a dish
  await page.waitForTimeout(500);
  await say(page, "final", "bill number 2, ek garlic naan, dine in table T1");
  await expect(sheet(page).getByTestId("voice-line")).toHaveCount(1);
  await expect(page.getByRole("dialog").getByTestId("voice-target")).toHaveText("Adding to Bill 2 (new)");
  await expect(sheet(page).getByTestId("voice-transcript")).toHaveText("bill number 2, ek garlic naan, dine in table T1");
});

test("\"lamb karahi\" alone does not wake it; after \"Hey Zonov\" it is still matched as a dish", async ({ page, context, request }) => {
  await waiting(page, context, request);
  await say(page, "final", "two lamb karahi");
  await say(page, "final", "okay two lamb karahi please");
  await page.waitForTimeout(800);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await say(page, "final", "hay zonov two lamb karahi");
  await expect(sheet(page).getByTestId("voice-line")).toHaveCount(1);
  await expect(sheet(page).getByTestId("voice-line")).toContainText("Lamb Karahi");
  await expect(sheet(page).getByTestId("voice-line")).toContainText("₹17.00");
  await expect(sheet(page).getByTestId("voice-transcript")).toHaveText("two lamb karahi");
});

test("after Add to order or Cancel it waits again, and the next \"Hey Zonov\" works (no tap)", async ({ page, context, request }) => {
  const s = await waiting(page, context, request);
  await say(page, "final", "hey zonov two lamb karahi");
  await expect(sheet(page).getByTestId("voice-line")).toHaveCount(1);
  expect(await orders(request, s)).toHaveLength(0); // nothing without the confirm step
  await sheet(page).getByRole("button", { name: /^Add to order/ }).click();
  await expect(page.getByText(/2 items added to/)).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(status(page)).toHaveText(/Waiting for “Hey Zonov”/, { timeout: 5000 });
  await expect.poll(() => live(page), { timeout: 5000 }).toBe(1);

  await say(page, "final", "ok jonov bill number 2 ek coke");
  await expect(page.getByRole("dialog").getByTestId("voice-target")).toHaveText("Adding to Bill 2 (new)");
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click(); // Cancel also goes back to waiting
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(tabs(page)).toHaveCount(1);
  await expect.poll(() => live(page), { timeout: 5000 }).toBe(1);

  await say(page, "final", "hey zonov ek garlic naan");
  await expect(sheet(page).getByTestId("voice-line")).toHaveCount(1);
  await sheet(page).getByRole("button", { name: /^Add to order/ }).click();
  await expect(tabs(page)).toHaveCount(1);
  await expect(page.getByRole("tab", { name: /^Bill 1, Takeaway, 3 items/ })).toBeVisible();
});

test("waiting never times out (silence), but the order after the wake phrase settles after a quiet spell", async ({ page, context, request }) => {
  const s = await waiting(page, context, request, { silenceMs: 1000 });
  await page.waitForTimeout(3500); // 3.5x the silence limit: still waiting
  expect(await live(page)).toBe(1);
  await expect(status(page)).toHaveText(/Waiting for “Hey Zonov”/);

  // woke but nothing said after the phrase: back to waiting by itself
  await say(page, "final", "hey zonov");
  await expect(sheet(page)).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 6000 });
  await expect.poll(() => live(page), { timeout: 5000 }).toBe(1);

  // order said, then quiet: the sheet settles on "Check the order"; nothing is added by itself
  await say(page, "final", "hey zonov ek coke");
  await expect(sheet(page).getByTestId("voice-line")).toHaveCount(1);
  await expect(page.getByRole("dialog", { name: "Check the order" })).toBeVisible({ timeout: 6000 });
  expect(await orders(request, s)).toHaveLength(0);
  await expect(page.getByRole("dialog", { name: "Check the order" }).getByTestId("voice-line")).toHaveCount(1);
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await expect.poll(() => live(page), { timeout: 5000 }).toBe(1);
});

test("the recogniser ending over and over never makes it give up; a failing speech service is reported and retried", async ({ page, context, request }) => {
  await waiting(page, context, request);
  for (let i = 0; i < 45; i++) await page.evaluate(() => (window as unknown as { __pause: () => void }).__pause()); // 45 ends: the old cap was 30
  expect(await live(page)).toBe(1);
  expect(await made(page)).toBe(46);
  await say(page, "final", "hey zonov ek coke");
  await expect(sheet(page).getByTestId("voice-line")).toHaveCount(1);
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await expect.poll(() => live(page), { timeout: 5000 }).toBe(1);

  // "network" errors: a clear status after a few, slower retries, and it recovers by itself
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => (window as unknown as { __fail: (c: string) => void }).__fail("network"));
    await expect.poll(() => live(page), { timeout: 8000 }).toBe(1);
  }
  await expect(status(page)).toHaveText(/keeps failing \(network\)/);
  await say(page, "final", "hey zonov ek coke"); // the service is back
  await expect(sheet(page).getByTestId("voice-woke")).toBeVisible();
});

test.describe("safeguards", () => {
  test("another dialog open: it does not wait, stops listening when one opens, resumes when it closes", async ({ page, context, request }) => {
    const s = await seedMenu(request, { serviceCharge: null });
    await context.grantPermissions(["microphone"]);
    await fakeSpeech(page, { handsFreeDefault: true });
    await openMenuPos(page, s);
    await expect.poll(() => live(page), { timeout: 5000 }).toBe(1);
    await page.getByRole("button", { name: "Add customer (optional)" }).click();
    await expect(page.getByRole("dialog", { name: "Choose a customer" })).toBeVisible();
    await expect.poll(() => live(page), { timeout: 3000 }).toBe(0);
    await page.waitForTimeout(1500);
    expect(await live(page)).toBe(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(status(page)).toHaveText(/Waiting for “Hey Zonov”/, { timeout: 5000 });
    await page.getByRole("button", { name: "Add customer (optional)" }).click();
    await expect.poll(() => live(page), { timeout: 3000 }).toBe(0);
    await page.keyboard.press("Escape");
    await expect.poll(() => live(page), { timeout: 5000 }).toBe(1);
  });

  test("a hidden tab pauses it and it resumes; a focused text box does NOT pause it any more (never sleep, owner 2026-11-02)", async ({ page, context, request }) => {
    const s = await seedMenu(request, { serviceCharge: null });
    await context.grantPermissions(["microphone"]);
    await fakeSpeech(page, { handsFreeDefault: true });
    await page.addInitScript(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => (window as unknown as { __hidden?: boolean }).__hidden === true });
    });
    await openMenuPos(page, s);
    await expect.poll(() => live(page), { timeout: 5000 }).toBe(1);
    await page.evaluate(() => { (window as unknown as { __hidden: boolean }).__hidden = true; document.dispatchEvent(new Event("visibilitychange")); });
    await expect.poll(() => live(page)).toBe(0);
    await page.waitForTimeout(1200);
    expect(await live(page)).toBe(0);
    await page.evaluate(() => { (window as unknown as { __hidden: boolean }).__hidden = false; document.dispatchEvent(new Event("visibilitychange")); });
    await expect.poll(() => live(page), { timeout: 5000 }).toBe(1);
    await page.getByRole("searchbox").or(page.getByPlaceholder(/Search/)).first().click();
    await page.waitForTimeout(1500);
    expect(await live(page)).toBe(1);
  });

  test("not while the bill is billed; English only; offline", async ({ page, context, request }) => {
    const s = await seedMenu(request, { serviceCharge: null });
    await context.grantPermissions(["microphone"]);
    await fakeSpeech(page, { handsFreeDefault: true });
    await openMenuPos(page, s, { sw: true });
    await page.getByRole("button", { name: /^Lamb Karahi,/ }).click();
    await page.getByRole("button", { name: "Place order" }).click();
    await expect(page.getByRole("button", { name: "Make bill" })).toBeVisible();
    await expect.poll(() => live(page), { timeout: 5000 }).toBe(1); // placed: still takes more items, so it listens
    await page.getByRole("button", { name: "Make bill" }).click(); // billed: locked
    await expect(status(page)).toHaveText(/this bill is already billed\. Open a new bill/);
    // C-23: the reason is in the mic's tooltip and the status (screen readers), never a bubble over the category chips
    await expect(page.getByRole("button", { name: /^Voice order/ })).toHaveAttribute("title", /already billed/);
    const hint = await page.evaluate(() => [...document.querySelectorAll("body *")].filter((el) => el.children.length === 0 && /Voice is paused/.test(el.textContent ?? "")
      && el.getBoundingClientRect().width > 2 && el.getBoundingClientRect().height > 2 && !el.closest("[role=dialog]")).length);
    expect(hint, "no visible hint bubble").toBe(0);
    await expect.poll(() => live(page)).toBe(0);
    await page.waitForTimeout(1200);
    expect(await live(page)).toBe(0);
    await page.getByRole("button", { name: "Open another order" }).click(); // a fresh bill: it waits
    await expect(status(page)).toHaveText(/Waiting for “Hey Zonov”/, { timeout: 5000 });

    if (LANGS) {
      await page.getByLabel("Voice language").selectOption("pa"); // another language pauses it
      await expect(status(page)).toHaveText("Hands-free works in English only");
      await page.getByLabel("Voice language").selectOption("en");
    }
    await expect.poll(() => live(page), { timeout: 5000 }).toBe(1);

    await context.setOffline(true);
    await expect(status(page)).toHaveText(/offline/, { timeout: 5000 });
    await expect.poll(() => live(page), { timeout: 3000 }).toBe(0);
    await context.setOffline(false);
    await expect.poll(() => live(page), { timeout: 8000 }).toBe(1);
  });

});

test.describe("switch and re-arm", () => {
  test("the off switch stops listening and is remembered; on again starts it", async ({ page, context, request }) => {
    await waiting(page, context, request);
    await handsFree(page).click();
    await expect(handsFree(page)).toHaveAttribute("aria-pressed", "false");
    await expect(handsFree(page)).toHaveAccessibleName("Hands-free “Hey Zonov”: Off");
    await expect.poll(() => live(page)).toBe(0);
    // remembered on this device (the fakeSpeech hook resets it on every load, so the stored value is checked, not a reload)
    expect(await page.evaluate(() => localStorage.getItem("pos.wakeOff"))).toBe("1");
    await page.waitForTimeout(1200);
    expect(await live(page)).toBe(0);
    await handsFree(page).click();
    await expect.poll(() => live(page), { timeout: 5000 }).toBe(1);
    await expect(handsFree(page)).toHaveAccessibleName("Hands-free “Hey Zonov”: Listening");
  });

  test("a failing speech service never puts it to sleep: it says Reconnecting, keeps trying, and listens again by itself (owner 2026-11-02)", async ({ page, context, request }) => {
    await waiting(page, context, request);
    for (let i = 0; i < 10; i++) {
      await expect.poll(() => live(page), { timeout: 15000 }).toBe(1); // a new recogniser every time, never a sleeping state
      await page.evaluate(() => (window as unknown as { __fail: (c: string) => void }).__fail("network"));
    }
    await expect(handsFree(page)).toHaveAccessibleName("Hands-free “Hey Zonov”: Reconnecting", { timeout: 15000 });
    await expect(status(page)).not.toHaveText(/kept failing/); // no "paused" / given-up state
    await expect.poll(() => live(page), { timeout: 15000 }).toBe(1);
    await expect(handsFree(page)).toHaveAccessibleName(/Hands-free “Hey Zonov”: (Listening|Reconnecting)/);
  });

  test("permission denied never loops: focus, visible tab and back online do not try again", async ({ page, request }) => {
    const s = await seedMenu(request, { serviceCharge: null });
    await fakeSpeech(page, { handsFreeDefault: true });
    await page.addInitScript(() => { Object.defineProperty(navigator, "permissions", { configurable: true, value: { query: async () => ({ state: "denied", addEventListener() {}, removeEventListener() {} }) } }); });
    await openMenuPos(page, s);
    await expect(status(page)).toHaveText(/Microphone not available/, { timeout: 8000 });
    await expect(handsFree(page)).toHaveAccessibleName("Hands-free “Hey Zonov”: Mic blocked");
    for (const ev of ["focus", "online"]) await page.evaluate((e) => window.dispatchEvent(new Event(e)), ev);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.waitForTimeout(2000);
    expect(await made(page)).toBe(0);
    await expect(status(page)).toHaveText(/Microphone not available/);
  });
});

test.describe("browser limits", () => {
  test("iOS-like browser (no gesture, no permission API): one clear 'Tap to start' state, then a tap opens the normal listening sheet", async ({ page, request }) => {
    const s = await seedMenu(request, { serviceCharge: null });
    await fakeSpeech(page, { needGesture: true, handsFreeDefault: true });
    await page.addInitScript(() => { Object.defineProperty(navigator, "permissions", { configurable: true, value: undefined }); });
    await openMenuPos(page, s);
    await expect(status(page)).toHaveText(/Tap the mic to start listening/, { timeout: 8000 });
    expect(await live(page)).toBe(0);
    await page.waitForTimeout(1500);
    await expect(status(page)).toHaveText(/Tap the mic to start listening/); // one state, no retry loop
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await mic(page).click();
    await expect(sheet(page).getByTestId("voice-live")).toBeVisible();
    await say(page, "final", "ek coke"); // a tapped session needs no wake phrase
    await expect(sheet(page).getByTestId("voice-line")).toHaveCount(1);
  });

  test("microphone permission not decided yet: it tries, the browser asks for it itself", async ({ page, request }) => {
    const s = await seedMenu(request, { serviceCharge: null });
    await fakeSpeech(page, { handsFreeDefault: true });
    await page.addInitScript(() => { Object.defineProperty(navigator, "permissions", { configurable: true, value: { query: async () => ({ state: "prompt" }) } }); });
    await openMenuPos(page, s);
    await expect.poll(() => made(page), { timeout: 5000 }).toBeGreaterThan(0);
    await expect(status(page)).toHaveText(/Waiting for “Hey Zonov”/);
  });

  test("tapping the mic while waiting starts a fresh session: what the wait heard is dropped", async ({ page, context, request }) => {
    await waiting(page, context, request);
    await say(page, "final", "ketchup two coke on table five"); // said before, never woke
    await mic(page).click();
    const dlg = sheet(page);
    await expect(dlg.getByTestId("voice-live")).toBeVisible();
    await expect(dlg.getByTestId("voice-line")).toHaveCount(0);
    await expect(page.getByText(/ketchup/)).toHaveCount(0);
    await say(page, "final", "ek garlic naan");
    await expect(dlg.getByTestId("voice-line")).toHaveCount(1);
  });
});

