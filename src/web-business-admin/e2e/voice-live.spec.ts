import { expect, test, type APIRequestContext, type Page, type Request } from "@playwright/test";
import { API, fakeSpeech, openMenuPos, say, seedMenu, type MenuSeed } from "./helpers";

// The voice-language chip is hidden while the app is English only (NEXT_PUBLIC_ENABLE_LANGUAGES off): the tests that switch it need the flag.
const LANGS = process.env.NEXT_PUBLIC_ENABLE_LANGUAGES === "true" || process.env.NEXT_PUBLIC_ENABLE_LANGUAGES === "1";

// Live voice ordering: the browser's SpeechRecognition is faked (interim + final results emitted by the test), the
// on-device parser puts lines on the confirm sheet while "speaking", and the AI endpoint is mocked / counted.
// Nothing reaches the ticket before "Add to order".

const orders = async (request: APIRequestContext, s: MenuSeed) => (await (await request.get(`${API}/orders`, { headers: s.auth })).json()) as
  { order_type: string; customer_id: string | null; lines: { item_id: string; quantity: number; unit_price: string }[] }[];

async function mockVoice(page: Page, body: unknown) {
  const sent: Request[] = [];
  await page.route("**/api/v1/ai/voice-order", async (route) => {
    sent.push(route.request());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  return sent;
}
const mic = (page: Page) => page.getByRole("button", { name: "Voice order", exact: true });

test("English is live: interim words, lines appear as final segments arrive, customer and type, then added", async ({ page, request }) => {
  const s = await seedMenu(request, { serviceCharge: null });
  await fakeSpeech(page);
  const sent = await mockVoice(page, {});
  await openMenuPos(page, s);

  await mic(page).click();
  const dlg = page.getByRole("dialog", { name: "Listening" });
  await expect(dlg.getByTestId("voice-live")).toBeVisible();
  await expect(dlg.getByTestId("voice-line")).toHaveCount(0);

  // words still being recognised show in the transcript, and the dish already appears (greyed: still pending)
  await say(page, "interim", "do lamb kar");
  await expect(dlg.getByTestId("voice-transcript")).toContainText("do lamb kar");
  await say(page, "interim", "do lamb karahi");
  await expect(dlg.getByTestId("voice-line")).toHaveCount(1, { timeout: 1000 });
  await expect(dlg.getByTestId("voice-line").first()).toContainText("Lamb Karahi");
  await expect(dlg.getByTestId("voice-line").first()).toHaveAttribute("data-pending", "true");

  await say(page, "final", "do lamb karahi");
  await expect(dlg.getByTestId("voice-line").first()).not.toHaveAttribute("data-pending", "true");
  await say(page, "interim", "ek garlic naan");
  await expect(dlg.getByTestId("voice-line")).toHaveCount(2, { timeout: 1000 });
  await say(page, "final", "ek garlic naan");
  await say(page, "final", "ek samosa chaat wala");
  await expect(dlg.getByTestId("voice-unmatched")).toHaveCount(1);
  await say(page, "final", "customer name Raj number 98765 43210 takeaway");
  await expect(dlg.getByLabel("Customer name")).toHaveValue("Raj");
  await expect(dlg.getByLabel("Customer phone")).toHaveValue("+919876543210");
  await expect(dlg.getByLabel("Order type")).toHaveValue("takeaway");
  // nothing on the ticket yet, and the AI was never called
  await expect(page.getByRole("button", { name: /^Customer:/ })).toHaveCount(0);
  expect(sent).toHaveLength(0);

  // a pause makes Chrome end the session: listening restarts by itself and keeps earlier lines
  await page.evaluate(() => (window as unknown as { __pause: () => void }).__pause());
  await expect(page.getByRole("dialog", { name: "Listening" }).getByTestId("voice-live")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __sr: unknown[] }).__sr.length)).toBe(2);
  await say(page, "final", "teen cucumber salad");
  await expect(dlg.getByTestId("voice-line")).toHaveCount(3);
  await expect(dlg.getByTestId("voice-line").nth(2)).toContainText("Cucumber Salad");

  // staff fix things while listening; later speech does not undo that
  await dlg.getByRole("button", { name: "Add one Garlic Naan" }).click();
  await dlg.getByRole("button", { name: "Drop “ek samosa chaat wala”" }).click();
  await say(page, "final", "ek coke");
  await expect(dlg.getByTestId("voice-line")).toHaveCount(4);
  await expect(dlg.getByTestId("voice-unmatched")).toHaveCount(0);

  await dlg.getByRole("button", { name: "Stop" }).click();
  const sheet = page.getByRole("dialog", { name: "Check the order" });
  await expect(sheet.getByTestId("voice-source")).toHaveText(/^Understood on device/);
  await expect(sheet.getByTestId("voice-line")).toHaveCount(4);
  await expect(sheet.getByText("Garlic Naan").first()).toBeVisible();
  await sheet.getByRole("button", { name: /^Add to order/ }).click();
  await expect(page.getByText(/items added to/)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Customer: Raj/ })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Takeaway" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.getByRole("button", { name: "Make bill" })).toBeVisible();
  const [o] = await orders(request, s);
  const qty = Object.fromEntries(o.lines.map((l) => [l.item_id, [l.quantity, l.unit_price]]));
  expect(qty).toEqual({ [s.items["Lamb Karahi"].id]: [2, "8.50"], [s.items["Garlic Naan"].id]: [2, "3.00"], [s.items["Coke"].id]: [1, "3.20"], [s.items["Cucumber Salad"].id]: [3, "4.50"] });
  expect(sent).toHaveLength(0);
});

test("lines appear within a second of the words; Stop and cancel add nothing", async ({ page, request }) => {
  const s = await seedMenu(request, { serviceCharge: null });
  await fakeSpeech(page);
  await openMenuPos(page, s);
  await mic(page).click();
  const dlg = page.getByRole("dialog", { name: "Listening" });
  const t0 = Date.now();
  await say(page, "final", "two lamb karahi");
  await expect(dlg.getByTestId("voice-line")).toHaveCount(1);
  const ms = Date.now() - t0;
  console.log(`live line appeared ${ms} ms after the final result`);
  expect(ms).toBeLessThan(1000);
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await expect(dlg).toBeHidden();
  expect(await orders(request, s)).toHaveLength(0);
});

test("ambiguous and low-confidence lines are flagged with a picker; Add to order while still listening works", async ({ page, request }) => {
  const s = await seedMenu(request, { serviceCharge: null });
  await fakeSpeech(page);
  await openMenuPos(page, s);
  await mic(page).click();
  const dlg = page.getByRole("dialog", { name: "Listening" });
  await say(page, "final", "one lamb karahi");
  await say(page, "final", "kukumber");
  await expect(dlg.getByTestId("voice-line")).toHaveCount(2);
  // a misheard word ("kukumber") still finds Cucumber Salad, but is flagged for a check. (A clear part of one dish's name,
  // "garlic" for Garlic Naan, is now simply picked: no extra tap when only one dish fits.)
  await expect(dlg.getByText(/not sure about this dish|dishes fit/)).toBeVisible();
  await dlg.getByRole("button", { name: /^Add to order/ }).click();
  await expect(page.getByText(/2 items added to/)).toBeVisible();
});

test("a failing recogniser (network) falls back to recording for the AI", async ({ page, request }) => {
  const s = await seedMenu(request, { serviceCharge: null });
  await fakeSpeech(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });
    class R { static isTypeSupported() { return true; } state = "inactive"; mimeType = "audio/webm"; ondataavailable: unknown = null; onstop: unknown = null;
      start() { this.state = "recording"; } stop() { this.state = "inactive"; (this.ondataavailable as (e: unknown) => void)({ data: new Blob([new Uint8Array([1, 2, 3])]) }); setTimeout(() => (this.onstop as () => void)(), 0); } }
    (window as unknown as { MediaRecorder: unknown }).MediaRecorder = R;
  });
  await openMenuPos(page, s);
  await mic(page).click();
  await page.evaluate(() => (window as unknown as { __fail: (c: string) => void }).__fail("network"));
  await expect(page.getByRole("dialog", { name: "Listening" }).getByText("Recording")).toBeVisible();
});

test("typed text is parsed on the device (no AI call); Improve with AI sends the unmatched phrases as TEXT", async ({ page, request }) => {
  const s = await seedMenu(request, { serviceCharge: null });
  await page.addInitScript(() => { for (const k of ["SpeechRecognition", "webkitSpeechRecognition"]) Object.defineProperty(window, k, { configurable: true, value: undefined }); });
  await page.addInitScript(() => { Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined }); });
  const sent = await mockVoice(page, {
    transcript: null, unmatched: [], customer: { name: null, phone: null, phone_heard: null }, order_type: null, table_label: null, table_id: null,
    lines: [{ item_id: s.items["Cucumber Salad"].id, item_name: "Cucumber Salad", variant_id: null, variant_name: null, quantity: 1, note: null, heard_text: "pizza", confidence: 0.9, needs_review: false, issues: [] }],
  });
  await openMenuPos(page, s);
  await mic(page).click();
  const dlg = page.getByRole("dialog", { name: "Type the order" });
  await dlg.getByLabel("Order").fill("do lamb karahi, ek pizza, table 1");
  await dlg.getByRole("button", { name: "Understand" }).click();
  const sheet = page.getByRole("dialog", { name: "Check the order" });
  await expect(sheet.getByTestId("voice-line")).toHaveCount(1);
  expect(sent).toHaveLength(0);
  await expect(sheet.getByTestId("voice-source")).toHaveText(/^Understood on device/);
  await expect(sheet.getByTestId("voice-unmatched")).toContainText("ek pizza");
  await sheet.getByRole("button", { name: "Improve with AI" }).click();
  await expect(sheet.getByTestId("voice-line")).toHaveCount(2);
  await expect(sheet.getByTestId("voice-unmatched")).toHaveCount(0);
  expect(sent).toHaveLength(1);
  const body = sent[0].postData() ?? "";
  expect(body).toContain("ek pizza");
  expect(body).not.toContain("filename="); // text, not audio
  expect(body).not.toContain("lamb karahi"); // only the unmatched phrase is sent
  await expect(sheet.getByTestId("voice-source")).toHaveAttribute("title", /matched 1 more phrase/);
  await sheet.getByRole("button", { name: /^Add to order \(3\)/ }).click();
  await expect(page.getByText(/3 items added to/)).toBeVisible();
});

test("language switch is remembered; Hindi / Punjabi record audio for the AI and the sheet says so", async ({ page, request }) => {
  test.skip(!LANGS, "voice language chip hidden: app is English only");
  const s = await seedMenu(request, { serviceCharge: null });
  await fakeSpeech(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });
    class R { static isTypeSupported(t: string) { return t.startsWith("audio/webm"); } state = "inactive"; mimeType = "audio/webm"; ondataavailable: unknown = null; onstop: unknown = null;
      start() { this.state = "recording"; } stop() { this.state = "inactive"; (this.ondataavailable as (e: unknown) => void)({ data: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1])], { type: "audio/webm" }) }); setTimeout(() => (this.onstop as () => void)(), 0); } }
    (window as unknown as { MediaRecorder: unknown }).MediaRecorder = R;
  });
  const sent = await mockVoice(page, {
    transcript: "do lamb karahi aur ek garlic naan, grahak ka naam priya", unmatched: [], customer: { name: "Priya", phone: null, phone_heard: null },
    order_type: null, table_label: null, table_id: null,
    lines: [
      { item_id: s.items["Lamb Karahi"].id, item_name: "Lamb Karahi", variant_id: null, variant_name: null, quantity: 2, note: null, heard_text: "do lamb karahi", confidence: 0.9, needs_review: false, issues: [] },
      { item_id: s.items["Garlic Naan"].id, item_name: "Garlic Naan", variant_id: null, variant_name: null, quantity: 1, note: null, heard_text: "ek garlic naan", confidence: 0.9, needs_review: false, issues: [] }],
  });
  await openMenuPos(page, s);
  const lang = page.getByLabel("Voice language");
  await expect(lang).toHaveValue("en");
  await lang.selectOption("hi");
  await mic(page).click();
  // Hindi: no live recogniser, the microphone is recorded instead
  const rec = page.getByRole("dialog", { name: "Listening" });
  await expect(rec.getByText("Recording", { exact: true })).toBeVisible();
  await expect(rec.getByTestId("voice-live")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __sr: unknown[] }).__sr.length)).toBe(0);
  await rec.getByRole("button", { name: "Stop and check" }).click();
  const sheet = page.getByRole("dialog", { name: "Check the order" });
  await expect(sheet.getByTestId("voice-line")).toHaveCount(2);
  await expect(sheet.getByTestId("voice-source")).toHaveText(/^Checked with AI/);
  expect(sent).toHaveLength(1);
  const raw = sent[0].postDataBuffer()!.toString("latin1");
  expect(raw).toMatch(/name="language"\r\n\r\nhi\r\n/);
  expect(raw).toMatch(/filename="order\.webm"/);
  await sheet.getByRole("button", { name: "Cancel" }).click();

  // remembered after a reload; Punjabi sends "pa"
  await page.reload();
  await expect(page.getByLabel("Voice language")).toHaveValue("hi");
  await page.getByLabel("Voice language").selectOption("pa");
  await mic(page).click();
  await page.getByRole("dialog", { name: "Listening" }).getByRole("button", { name: "Stop and check" }).click();
  await expect(page.getByRole("dialog", { name: "Check the order" }).getByTestId("voice-line")).toHaveCount(2);
  expect(sent[1].postDataBuffer()!.toString("latin1")).toMatch(/name="language"\r\n\r\npa\r\n/);
  await page.getByRole("dialog", { name: "Check the order" }).getByRole("button", { name: /^Add to order/ }).click();
  await expect(page.getByText(/3 items added to/)).toBeVisible();
  await page.getByLabel("Voice language").selectOption("en");
});

test("offline: on-device English recognition keeps the mic usable; without it the mic says why", async ({ page, context, request }) => {
  const s = await seedMenu(request, { serviceCharge: null });
  await fakeSpeech(page);
  await page.addInitScript(() => {
    (window as unknown as { SpeechRecognition: { available: () => Promise<string> } }).SpeechRecognition.available = async () => "available";
  });
  await openMenuPos(page, s, { sw: true });
  await context.setOffline(true);
  await expect(page.getByRole("button", { name: "Voice order (needs internet)" })).toBeDisabled();
  await page.getByRole("button", { name: "Voice order (needs internet)" }).click({ force: true });
  const dlg = page.getByRole("dialog", { name: "Listening" });
  await expect(dlg.getByText(/offline/)).toBeVisible();
  await say(page, "final", "two lamb karahi");
  await expect(dlg.getByTestId("voice-line")).toHaveCount(1);
  await dlg.getByRole("button", { name: /^Add to order/ }).click();
  await expect(page.getByText(/2 items added to/)).toBeVisible();
  await context.setOffline(false);
});
