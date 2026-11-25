import { expect, test, type APIRequestContext, type BrowserContext, type Page, type Request } from "@playwright/test";
import { openAs } from "./helpers";
import { installHarness, qa, seedOwner, tickets, type OwnerMenu } from "./voice-qa-harness";

// Round 2 (docs/VOICE_QA_REPORT.md): the mic must never stay dead until a reload, "Hey Zonov" must wake for an Indian accent,
// training / auto-learn stay on the device, and the testing-phase sharing is switched by the server only. Scripted recogniser
// (voice-qa-harness.ts) with failure injection; the wake-config / wake-samples endpoints are mocked here.

const status = (page: Page) => page.getByTestId("auto-status");
const handsFree = (page: Page) => page.getByTestId("hands-free");
const sheet = (page: Page) => page.getByRole("dialog");
const cart = async (page: Page) => (await tickets(page)).flatMap((t) => [...t.lines, ...t.more]).map((l) => `${l.name} x${l.qty}`).sort();

interface Mock { config: { share_samples: boolean; variants: string[] }; samplesStatus: number; posts: unknown[]; voiceCalls: string[] }
async function setup(page: Page, context: BrowserContext, request: APIRequestContext, opts: { share?: boolean } = {}) {
  const m = await seedOwner(request);
  await context.grantPermissions(["microphone"]);
  await installHarness(page, { handsFree: true, silenceMs: 4000, busyAfterCloseMs: 300 });
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__POS_VOICE_RETRY_MS = 1500; // the hands-free retry while "sleeping" (15 s ... 5 min in the app)
    w.__POS_VOICE_WATCHDOG = { startGraceMs: 1500, silentMaxMs: 4000, ...(w.__POS_VOICE_WATCHDOG as object ?? {}) };
  });
  const mock: Mock = { config: { share_samples: !!opts.share, variants: [] }, samplesStatus: 204, posts: [], voiceCalls: [] };
  await page.route("**/api/v1/voice/wake-config", (r) => r.fulfill({ json: mock.config }));
  await page.route("**/api/v1/voice/wake-samples", async (r) => { mock.posts.push(r.request().postDataJSON()); await r.fulfill({ status: mock.samplesStatus, body: "" }); });
  page.on("request", (r: Request) => { if (/\/voice\/|wake|learn/i.test(r.url())) mock.voiceCalls.push(`${r.method()} ${r.url()}`); });
  await openAs(page, m.token, "/pos", m.refresh);
  await expect(page.getByRole("button", { name: /^Matar Paneer,/ }).first()).toBeVisible();
  await waiting(page);
  return { m, mock };
}

/** Hands-free is waiting for the wake phrase again, with exactly one recogniser running. */
async function waiting(page: Page, timeout = 30_000) {
  await expect.poll(() => qa(page, "newestListening"), { timeout, message: "a recogniser is listening" }).toBe(true);
  await expect(status(page)).toHaveText(/Waiting for “Hey Zonov”/, { timeout });
  expect(await qa(page, "listening")).toBeLessThanOrEqual(1);
}
/** One order by voice; the sheet must open and the dish must reach the cart. */
async function order(page: Page, wake: string, dish = "one lassi", want = "Sweet Lassi") {
  await qa(page, "final", `${wake} ${dish}, done`);
  await expect.poll(async () => (await cart(page)).some((l) => l.startsWith(want)), { timeout: 15_000, message: `${wake}: ${dish} added` }).toBe(true);
  await expect(sheet(page)).toHaveCount(0);
}

test.use({ viewport: { width: 1280, height: 800 } });

test.describe("the mic never stays dead (no reload)", () => {
  for (const code of ["network", "audio-capture", "service-not-allowed-transient", "aborted", "no-speech"]) {
    test(`a storm of '${code}' errors: hands-free reconnects by itself, then Hey Zonov works`, async ({ page, context, request }) => {
      await setup(page, context, request);
      const real = code === "service-not-allowed-transient" ? "network" : code;
      for (let i = 0; i < 7; i++) {
        await expect.poll(() => qa(page, "newestListening"), { timeout: 20_000 }).toBe(true);
        await qa(page, "error", real);
      }
      await waiting(page, 40_000);
      await order(page, "hey jonov");
      expect(await qa(page, "listening")).toBeLessThanOrEqual(1);
    });
  }

  test("a recogniser that dies silently (laptop sleep, lid, device switch) is replaced by the watchdog", async ({ page, context, request }) => {
    await setup(page, context, request);
    const before = await qa(page, "count");
    await qa(page, "kill");
    await expect.poll(() => qa(page, "count"), { timeout: 20_000 }).toBeGreaterThan(before);
    await waiting(page);
    await order(page, "hey sonov");
  });

  test("starts that never report, and starts that throw, are retried", async ({ page, context, request }) => {
    await setup(page, context, request);
    await qa(page, "noStartNext", 2);
    await qa(page, "throwNext", 3);
    await qa(page, "error", "network");
    await waiting(page, 40_000);
    await order(page, "a zonov");
  });

  test("a microphone plugged in or out restarts listening", async ({ page, context, request }) => {
    await setup(page, context, request);
    const before = await qa(page, "count");
    await qa(page, "deviceChange");
    await expect.poll(() => qa(page, "count"), { timeout: 10_000 }).toBeGreaterThan(before);
    await waiting(page);
    await order(page, "hey zonoff");
  });

  test("tab hidden then shown: listening stops and comes back", async ({ page, context, request }) => {
    await setup(page, context, request);
    await qa(page, "hide", true);
    await expect.poll(() => qa(page, "listening"), { timeout: 10_000 }).toBe(0);
    await qa(page, "hide", false);
    await waiting(page);
    await order(page, "he zono");
  });

  test("'Mic not working? Reset' brings a sleeping hands-free back at once, and is in Voice settings", async ({ page, context, request }) => {
    await setup(page, context, request);
    await page.evaluate(() => { (window as unknown as Record<string, unknown>).__POS_VOICE_RETRY_MS = 600_000; }); // no automatic retry in this test
    // fail every restart until hands-free gives up and sleeps ("Reconnecting")
    for (let i = 0; i < 20 && !/Reconnecting/.test((await handsFree(page).getAttribute("aria-label")) ?? ""); i++) {
      if (await qa(page, "newestListening")) await qa(page, "error", "network");
      await page.waitForTimeout(400);
    }
    await expect(handsFree(page)).toHaveAccessibleName("Hands-free “Hey Zonov”: Reconnecting", { timeout: 30_000 });
    await page.getByTestId("voice-reset").click();
    await expect(page.getByText("Microphone reset")).toBeVisible();
    await waiting(page);
    await order(page, "hey jonoff");
    await page.getByTestId("voice-settings").click();
    await expect(page.getByTestId("voice-reset-settings")).toBeVisible();
  });

  test("closing the sheet while the microphone is still opening releases it (recording fallback)", async ({ page, context, request }) => {
    await setup(page, context, request);
    await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      w.__stopped = 0;
      // a REAL audio stream (MediaRecorder accepts it), whose track counts stop()
      const make = () => { const ctx = new AudioContext(); const st = ctx.createMediaStreamDestination().stream; for (const t of st.getTracks()) { const stop = t.stop.bind(t); t.stop = () => { w.__stopped = (w.__stopped as number) + 1; stop(); }; } return st; };
      navigator.mediaDevices.getUserMedia = () => new Promise((ok) => setTimeout(() => ok(make()), 800));
    });
    await qa(page, "errorOnStart", "service-not-allowed", 1); // the tapped recogniser cannot start -> recording for the AI
    await page.getByRole("button", { name: /^Voice order/ }).click();
    await expect(page.getByText("Starting the microphone…")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect.poll(() => page.evaluate(() => (window as unknown as { __stopped: number }).__stopped), { timeout: 5000 }).toBe(1);
  });
});

test.describe("Hey Zonov for an Indian accent", () => {
  test("the owner's spellings wake it in the real app (Latin and Devanagari), everyday words do not", async ({ page, context, request }) => {
    await setup(page, context, request);
    for (const w of ["hey jonov", "hey sunao", "हे जोनोव"]) {
      await qa(page, "final", w);
      await expect(sheet(page), w).toBeVisible();
      await page.keyboard.press("Escape");
      await waiting(page);
    }
    for (const w of ["hey sonu", "hey jaanu", "hello"]) {
      await qa(page, "final", w);
      await page.waitForTimeout(600);
      await expect(sheet(page), w).toHaveCount(0);
    }
    await page.getByTestId("voice-settings").click();
    await expect(page.getByTestId("voice-last-heard")).toContainText("hello");
  });

  test("Train Hey Zonov: 5 samples, the close ones are learned, Test says matched; delete and reset", async ({ page, context, request }) => {
    const { mock } = await setup(page, context, request);
    await page.getByTestId("voice-settings").click();
    const dlg = page.getByRole("dialog", { name: "Voice settings" });
    await dlg.getByRole("button", { name: "Train “Hey Zonov”" }).click();
    await expect(dlg.getByTestId("voice-train-status")).toContainText("1 of 5");
    await expect.poll(() => qa(page, "newestListening")).toBe(true);
    for (const s of ["hey sanob", "hey sanob", "pizza please", "hey sanob", "hey jonov"]) { await qa(page, "interim", s.split(" ")[0]); await qa(page, "interim", s); await qa(page, "final", s); await page.waitForTimeout(150); }
    await expect(dlg.getByTestId("voice-train-samples")).toContainText("learned");
    await expect(dlg.getByTestId("voice-train-samples")).toContainText("not kept");
    await expect(dlg.getByTestId("voice-learned")).toContainText("hey sanob");
    await dlg.getByRole("button", { name: "Test" }).click();
    await expect.poll(() => qa(page, "newestListening")).toBe(true);
    await qa(page, "final", "hey sanob");
    await expect(dlg.getByTestId("voice-test-result")).toHaveText("Heard: “hey sanob” (matched)");
    await page.screenshot({ path: "docs/voice-qa-shots/8-train.png" });
    await dlg.getByRole("button", { name: "Forget “hey sanob”" }).click();
    await expect(dlg.getByTestId("voice-learned")).toHaveCount(0);
    expect(mock.voiceCalls.filter((c) => /wake-samples/.test(c))).toEqual([]); // training sends nothing
  });

  test("auto-learn: a near miss before a voice order that succeeded is learned on the device, with no network call", async ({ page, context, request }) => {
    const { mock } = await setup(page, context, request);
    await qa(page, "final", "hey sanob");
    await page.waitForTimeout(500);
    await expect(sheet(page)).toHaveCount(0);
    await order(page, "hey zonov");
    await expect(page.getByText(/Learned how you say “Hey Zonov” \(“hey sanob”\)/)).toBeVisible();
    expect(mock.voiceCalls.filter((c) => !/GET .*\/voice\/wake-config$/.test(c))).toEqual([]); // nothing but the config read
    await waiting(page);
    await order(page, "hey sanob", "one mango lassi", "Mango Lassi");
    await page.getByTestId("voice-settings").click();
    await expect(page.getByTestId("voice-learned")).toContainText("hey sanob");
    await page.getByTestId("voice-auto-learn").uncheck();
    await expect(page.getByText("Learned on this device only. Nothing is sent to our servers.", { exact: false })).toBeVisible();
  });
});

test.describe("degrading over time (owner: works after a hard refresh, then not; B18)", () => {
  test("'Hey Zonov' only in the recogniser's 2nd guess still wakes it, and the order words follow", async ({ page, context, request }) => {
    await setup(page, context, request);
    await qa(page, "finalAlts", ["hey Jonas one lassi", "hey zonov one lassi", "hey zone of one lassi"]);
    await expect(sheet(page)).toBeVisible();
    await qa(page, "final", "done");
    await expect.poll(() => cart(page)).toEqual(["Sweet Lassi x1"]);
  });
  test("the name alone, as the first word, wakes it ('Zonov one lassi', 'hazonov')", async ({ page, context, request }) => {
    await setup(page, context, request);
    await order(page, "Zonov");
    await waiting(page);
    await order(page, "hazonov", "one mango lassi", "Mango Lassi");
  });
  test("a deaf recogniser (speech heard, no result) is recreated by itself and logged", async ({ page, context, request }) => {
    await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__POS_VOICE_WATCHDOG = { startGraceMs: 1500, silentMaxMs: 60_000, deafMs: 2000 }; });
    await setup(page, context, request);
    const before = await qa(page, "count");
    await qa(page, "speechStart");
    await expect.poll(() => qa(page, "count"), { timeout: 15_000 }).toBeGreaterThan(before);
    await waiting(page);
    await order(page, "hey zonov");
  });
});

test.describe("never sleep: speech the recogniser missed (a restart gap) goes to the server's speech-to-text", () => {
  const reply = (transcript: string) => ({ transcript, lines: [], unmatched: [], clarifications: [], needs_clarification: false, customer: { name: null, phone: null, phone_heard: null }, order_type: null, table_label: null, table_id: null, command: null, model_used: false });
  test("an utterance with no recogniser result is transcribed by the server and wakes the till; one the recogniser heard is not sent", async ({ page, context, request }) => {
    const stt: string[] = [];
    await page.route("**/api/v1/ai/voice-order", (r) => { stt.push(r.request().method()); return r.fulfill({ json: reply("hey zonov one lassi") }); });
    await setup(page, context, request);
    await page.evaluate(() => (window as unknown as { __micGuardUtterance: (ms: number) => void }).__micGuardUtterance(1200));
    await expect(sheet(page)).toBeVisible({ timeout: 10_000 });
    await expect(sheet(page).getByTestId("voice-line")).toContainText("Sweet Lassi");
    expect(stt).toHaveLength(1);
    await qa(page, "final", "done");
    await expect.poll(() => cart(page)).toEqual(["Sweet Lassi x1"]);
    // speech the recogniser DID hear is never sent again
    await waiting(page);
    await qa(page, "final", "two lassi please");
    await page.evaluate(() => (window as unknown as { __micGuardUtterance: (ms: number) => void }).__micGuardUtterance(800));
    await page.waitForTimeout(2500);
    expect(stt).toHaveLength(1);
  });
});

test.describe("testing-phase sharing (server-switched, text only)", () => {
  test("flag off (production): no sample request, no notice", async ({ page, context, request }) => {
    const { mock } = await setup(page, context, request, { share: false });
    await order(page, "hey jonov");
    await page.waitForTimeout(1500);
    expect(mock.posts).toEqual([]);
    await page.getByTestId("voice-settings").click();
    await expect(page.getByTestId("voice-share")).toHaveCount(0);
  });

  test("flag on: batched text-only samples without digits; the switch off stops them; 403 stops them", async ({ page, context, request }) => {
    const { mock } = await setup(page, context, request, { share: true });
    await qa(page, "final", "hey jonov two lassi, number 98765 43210, done");
    await expect.poll(() => mock.posts.length, { timeout: 10_000 }).toBeGreaterThan(0);
    const all = (mock.posts as { samples: { heard: string; matched: boolean; kind: string; device: string }[] }[]).flatMap((p) => p.samples);
    for (const s of all) {
      expect(Object.keys(s).sort()).toEqual(["device", "heard", "kind", "matched"]);
      expect(s.heard).not.toMatch(/\d/);
      expect(s.heard.length).toBeLessThanOrEqual(120);
    }
    await page.getByTestId("voice-settings").click();
    await expect(page.getByTestId("voice-share")).toContainText("Testing build: the words the mic hears are sent to improve recognition. No audio is stored.");
    await page.getByTestId("voice-share-switch").uncheck();
    await page.keyboard.press("Escape");
    const n = mock.posts.length;
    await waiting(page);
    await order(page, "hey sonov", "one mango lassi", "Mango Lassi");
    await page.waitForTimeout(2000);
    expect(mock.posts.length).toBe(n);
  });

  test("flag on, then the server answers 403: sending stops for the page", async ({ page, context, request }) => {
    const { mock } = await setup(page, context, request, { share: true });
    mock.samplesStatus = 403;
    await order(page, "hey jonov");
    await expect.poll(() => mock.posts.length, { timeout: 10_000 }).toBe(1);
    await waiting(page);
    await order(page, "hey sonov", "one mango lassi", "Mango Lassi");
    await page.waitForTimeout(2000);
    expect(mock.posts.length).toBe(1);
    await page.getByTestId("voice-settings").click();
    await expect(page.getByTestId("voice-share")).toHaveCount(0);
  });
});

test.describe("the same dish said again (owner, 2026-11-02)", () => {
  test("one line whose quantity goes up, on the sheet (other spellings too) and in the cart; then one order with one KOT", async ({ page, context, request }) => {
    const { m } = await setup(page, context, request);
    await qa(page, "final", "hey zonov one butter chicken, one butter chican");
    const lines = sheet(page).getByTestId("voice-line");
    await expect(lines).toHaveCount(1);
    await expect(sheet(page).getByTestId("voice-merged")).toHaveText("Said 2 times: now ×2");
    await page.screenshot({ path: "docs/voice-qa-shots/9-same-dish.png" });
    await qa(page, "final", "done");
    await expect.poll(() => cart(page)).toEqual(["Butter Chicken x2"]);
    await waiting(page);
    await qa(page, "final", "hey jonov ek butter chiken, done");
    await expect.poll(() => cart(page)).toEqual(["Butter Chicken x3"]);
    await expect(page.getByText(/Butter Chicken.* now ×3/)).toBeVisible();
    await waiting(page);
    await qa(page, "final", "hey zonov place order");
    const auth = { Authorization: `Bearer ${m.token}` };
    await expect.poll(async () => (await (await request.get(`${process.env.E2E_API_BASE ?? `http://localhost:${process.env.E2E_API_PORT ?? "8120"}/api/v1`}/kot`, { headers: auth })).json()).length, { timeout: 30_000 }).toBe(1);
    const orders = await (await request.get(`${process.env.E2E_API_BASE ?? `http://localhost:${process.env.E2E_API_PORT ?? "8120"}/api/v1`}/orders`, { headers: auth })).json() as { lines: { item_name: string; quantity: number }[] }[];
    expect(orders).toHaveLength(1);
    expect(orders[0].lines.map((l) => l.quantity)).toEqual([3]);
  });
});

test.describe("Mic debug box (testing phase)", () => {
  test("shows interim, final, wake, error and restart lines; Copy log copies plain text; no network request", async ({ page, context, request }) => {
    await context.grantPermissions(["microphone", "clipboard-read", "clipboard-write"]);
    await page.addInitScript(() => { localStorage.setItem("pos.micDebug", "1"); localStorage.setItem("pos.micDebugOpen", "1"); });
    const { mock } = await setup(page, context, request);
    const toggle = page.getByTestId("mic-debug").getByRole("button", { name: /Mic debug/ });
    await expect(toggle).toHaveAttribute("aria-expanded", "true"); // remembered open (collapsed by default)
    const log = page.getByTestId("mic-debug-log");
    await qa(page, "interim", "hey jo");
    await qa(page, "final", "hey sonu");
    await qa(page, "error", "network");
    await waiting(page);
    await qa(page, "final", "hey jonov");
    await expect(log).toContainText("interim: “hey jo”");
    await expect(log).toContainText("final: “hey sonu”");
    await expect(log).toContainText("no wake: “sonu” is an everyday word");
    await expect(log).toContainText("error network");
    await expect(log).toContainText(/restart scheduled in \d+ ms/);
    await expect(log).toContainText("WAKE matched (sensitivity normal, heard “hey jonov”, key=ZANAV, distance=0)");
    await expect(page.getByTestId("mic-debug-header")).toContainText(/recognisers [01] /);
    await page.keyboard.press("Escape");
    await page.getByTestId("mic-debug").getByRole("button", { name: "Copy log" }).click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip.split("\n")[0]).toMatch(/^Chilli Agent mic log /);
    expect(clip).toContain("WAKE matched");
    expect(mock.voiceCalls.filter((c) => !/GET .*\/voice\/wake-config$/.test(c))).toEqual([]);
    await page.screenshot({ path: "docs/voice-qa-shots/10-mic-debug.png" });
  });
});

test.describe("Direct mode (owner, 2026-11-02)", () => {
  test("dishes go straight into the selected bill without Hey Zonov; chatter is ignored; undo; place order sends it", async ({ page, context, request }) => {
    await page.addInitScript(() => { localStorage.setItem("pos.voiceDirect", "1"); });
    const { m } = await setup(page, context, request);
    await expect(page.getByTestId("direct-mode")).toHaveText("Direct mode ON");
    await qa(page, "final", "one butter chicken");
    await expect.poll(() => cart(page)).toEqual(["Butter Chicken x1"]);
    await expect(page.getByText("Added to Bill 1: Butter Chicken ×1")).toBeVisible();
    await expect(sheet(page)).toHaveCount(0);
    await qa(page, "final", "we need more ketchup on table five");
    await qa(page, "final", "the butter chicken was really good");
    await page.waitForTimeout(800);
    expect(await cart(page)).toEqual(["Butter Chicken x1"]);
    await qa(page, "final", "do lassi");
    await expect.poll(() => cart(page)).toEqual(["Butter Chicken x1", "Sweet Lassi x2"]);
    await qa(page, "final", "undo");
    await expect.poll(() => cart(page)).toEqual(["Butter Chicken x1"]);
    await page.screenshot({ path: "docs/voice-qa-shots/11-direct-mode.png" });
    await qa(page, "final", "place order");
    await expect(page.getByTestId("voice-countdown")).toBeVisible();
    const api = `http://localhost:${process.env.E2E_API_PORT ?? "8120"}/api/v1`;
    await expect.poll(async () => (await (await request.get(`${api}/kot`, { headers: { Authorization: `Bearer ${m.token}` } })).json()).length, { timeout: 30_000 }).toBe(1);
  });

  test("'bill 2 me ...' goes to Bill 2 and selects it; a bill that is not open is never created", async ({ page, context, request }) => {
    await page.addInitScript(() => { localStorage.setItem("pos.voiceDirect", "1"); });
    await setup(page, context, request);
    await page.getByRole("button", { name: /^New/ }).first().dispatchEvent("click");
    await expect(page.getByRole("tablist", { name: "Open orders" }).getByRole("tab")).toHaveCount(2);
    await page.getByRole("tablist", { name: "Open orders" }).getByRole("tab").first().click();
    await waiting(page);
    await qa(page, "final", "bill 2 me ek matar paneer");
    await expect.poll(async () => (await tickets(page)).find((t) => t.no === 2)?.lines.map((l) => `${l.name} x${l.qty}`)).toEqual(["Matar Paneer x1"]);
    await expect(page.getByRole("tablist", { name: "Open orders" }).getByRole("tab", { selected: true })).toContainText("Bill 2");
    await waiting(page);
    await qa(page, "final", "bill 7 me ek lassi");
    await expect(page.getByText("Bill 7 is not open")).toBeVisible();
    expect((await tickets(page)).map((t) => t.no).sort()).toEqual([1, 2]);
  });
});

test.describe("Veg only at the counter (owner, 2026-11-02)", () => {
  async function vegMenu(page: Page, context: BrowserContext, request: APIRequestContext, vegOnly: boolean) {
    if (vegOnly) await page.addInitScript(() => { localStorage.setItem("pos.vegOnly", "1"); });
    const api = `http://localhost:${process.env.E2E_API_PORT ?? "8120"}/api/v1`;
    // the dishes' food types (before the till loads the menu)
    const m0 = await seedOwner(request);
    const h = { headers: m0.auth };
    for (const [name, ft] of [["Butter Chicken", "non_veg"], ["Chicken Biryani", "non_veg"], ["Mutton Biryani", "non_veg"], ["Matar Paneer", "veg"], ["Sweet Lassi", "veg"], ["Mango Lassi", "veg"], ["Tandoori Roti", "veg"], ["Dal Makhani", "veg"], ["Garlic Naan", "veg"], ["Jeera Rice", "veg"]] as const) {
      const r = await request.patch(`${api}/menu/items/${m0.ids[name]}`, { ...h, data: { food_type: ft } });
      expect(r.status(), await r.text()).toBeLessThan(300);
    }
    const cat = (await (await request.get(`${api}/menu/categories`, h)).json() as { id: string; name: string }[]).find((c) => c.name === "Rice")!;
    const vb = await request.post(`${api}/menu/items`, { ...h, data: { category_id: cat.id, name: "Veg Biryani", price: "200.00", food_type: "veg" } });
    expect(vb.status(), await vb.text()).toBe(201);
    await context.grantPermissions(["microphone"]);
    await installHarness(page, { handsFree: true, silenceMs: 4000 });
    await openAs(page, m0.token, "/pos", m0.refresh);
    await expect(page.getByRole("button", { name: /^Matar Paneer,/ }).first()).toBeVisible();
    await waiting(page);
  }
  test("Veg only on: 'one butter chicken' is not added (message + Add anyway), the veg dish is; 'biryani' -> Veg Biryani", async ({ page, context, request }) => {
    await vegMenu(page, context, request, true);
    await qa(page, "final", "hey zonov one butter chicken, one matar paneer, done");
    await expect.poll(() => cart(page)).toEqual(["Matar Paneer x1"]);
    const veto = sheet(page).getByTestId("voice-veg-veto");
    await expect(veto).toContainText("Butter Chicken is non-veg and Veg only is on.");
    await page.screenshot({ path: "docs/voice-qa-shots/12-veg-only.png" });
    await veto.getByRole("button", { name: "Add anyway" }).click();
    await sheet(page).getByRole("button", { name: /^Add to order/ }).click();
    await expect.poll(() => cart(page)).toEqual(["Butter Chicken x1", "Matar Paneer x1"]);
    await expect(page.getByTestId("veg-only")).toHaveAttribute("aria-pressed", "true"); // the filter stays on
    await waiting(page);
    await qa(page, "final", "hey zonov one biryani, done");
    await expect.poll(() => cart(page)).toEqual(["Butter Chicken x1", "Matar Paneer x1", "Veg Biryani x1"]);
  });
  test("Veg only off: normal behaviour", async ({ page, context, request }) => {
    await vegMenu(page, context, request, false);
    await qa(page, "final", "hey zonov one butter chicken, done");
    await expect.poll(() => cart(page)).toEqual(["Butter Chicken x1"]);
  });
});

/** 50 sessions, each after a random injected failure: every one must end with the order in the cart, never two recognisers. */
test("soak: 50 voice orders, each after a random mic failure, no reload", async ({ page, context, request }) => {
  test.setTimeout(30 * 60_000);
  await setup(page, context, request);
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const failures = ["network", "audio-capture", "aborted", "no-speech", "kill", "throw", "nostart", "device", "hide", "none"];
  const wakes = ["hey zonov", "hey jonov", "hey sonov", "a zonov", "hey zonoff", "hey zonav", "he zono", "hey jonoff", "hey sunao", "हे जोनोव"];
  const dishes: [string, string][] = [["one lassi", "Sweet Lassi"], ["one mango lassi", "Mango Lassi"], ["one matar paneer", "Matar Paneer"], ["one chapati", "Tandoori Roti"]];
  const failed: string[] = [];
  for (let i = 0; i < 50; i++) {
    const f = failures[Math.floor(rnd() * failures.length)], w = wakes[Math.floor(rnd() * wakes.length)], d = dishes[Math.floor(rnd() * dishes.length)];
    try {
      await waiting(page, 45_000);
      if (f === "kill") await qa(page, "kill");
      else if (f === "throw") { await qa(page, "throwNext", 2); await qa(page, "error", "network"); }
      else if (f === "nostart") { await qa(page, "noStartNext", 1); await qa(page, "error", "network"); }
      else if (f === "device") { await qa(page, "deviceChange"); await page.waitForTimeout(900); } // the listener restarts 0.5 s after a device change
      else if (f === "hide") { await qa(page, "hide", true); await page.waitForTimeout(400); await qa(page, "hide", false); }
      else if (f !== "none") for (let k = 0; k < 1 + Math.floor(rnd() * 7); k++) { await expect.poll(() => qa(page, "newestListening"), { timeout: 30_000 }).toBe(true); await qa(page, "error", f); }
      await waiting(page, 45_000);
      const qtyOf = async () => (await tickets(page)).flatMap((t) => [...t.lines, ...t.more]).filter((l) => l.name === d[1]).reduce((n, l) => n + l.qty, 0);
      const before = await qtyOf(); // the same dish again merges into its line: count quantities, not lines
      await qa(page, "final", `${w} ${d[0]}, done`);
      await expect.poll(qtyOf, { timeout: 15_000 }).toBe(before + 1);
      await expect(sheet(page)).toHaveCount(0);
      expect(await qa(page, "listening")).toBeLessThanOrEqual(1);
    } catch (e) {
      failed.push(`#${i} ${f} "${w}": ${(e as Error).message.split("\n")[0]}`);
      await page.keyboard.press("Escape").catch(() => {});
    }
    // a fresh cart now and then keeps the ticket small
    if (i % 10 === 9) await page.getByRole("button", { name: /^New/ }).first().dispatchEvent("click");
  }
  console.log(`MIC SOAK 50: ${failed.length} failed\n${failed.join("\n")}`);
  expect(failed).toEqual([]);
});

export type { OwnerMenu };

test.describe("accessibility of the new voice UI (axe, light palette)", () => {
  test("Direct mode chip, mic debug box (open), Voice settings: no serious / critical axe violations", async ({ page, context, request }) => {
    const AxeBuilder = (await import("@axe-core/playwright")).default;
    await page.addInitScript(() => { localStorage.setItem("pos.voiceDirect", "1"); localStorage.setItem("pos.micDebug", "1"); localStorage.setItem("pos.micDebugOpen", "1"); });
    await setup(page, context, request);
    await expect(page.getByTestId("direct-mode")).toBeVisible();
    await qa(page, "interim", "hey jo");
    await qa(page, "final", "hey sonu");
    const bad = async (where: string) => {
      const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
      return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${where}: ${v.id} ${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(" | ")}`);
    };
    expect(await bad("counter")).toEqual([]);
    await page.getByTestId("voice-settings").click();
    await expect(page.getByRole("dialog", { name: "Voice settings" })).toBeVisible();
    expect(await bad("voice settings")).toEqual([]);
  });
});
