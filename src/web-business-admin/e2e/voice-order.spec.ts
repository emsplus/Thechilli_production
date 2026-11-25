import { expect, test, type APIRequestContext, type Page, type Request } from "@playwright/test";
import { API, openMenuPos, seedMenu, type MenuSeed } from "./helpers";

// Voice ordering from the till. The model is never called: the backend endpoint is mocked with page.route (its own
// validation is covered by apps/api/tests/test_voice_order.py). Nothing reaches the ticket before "Add to order".

interface Cust { id: string; name: string | null; phone: string | null }
const customers = async (request: APIRequestContext, s: MenuSeed) => (await (await request.get(`${API}/customers`, { headers: s.auth })).json()) as Cust[];
const orders = async (request: APIRequestContext, s: MenuSeed) => (await (await request.get(`${API}/orders`, { headers: s.auth })).json()) as
  { id: string; order_type: string; customer_id: string | null; lines: { item_id: string; quantity: number; unit_price: string }[] }[];

function reply(s: MenuSeed, extra: Record<string, unknown> = {}) {
  return {
    transcript: "do lamb karahi, ek garlic naan, ek samosa chaat, customer ka naam Raj, number 098765 00123, takeaway",
    lines: [
      { item_id: s.items["Lamb Karahi"].id, item_name: "Lamb Karahi", variant_id: null, variant_name: null, quantity: 2, note: "extra spicy",
        heard_text: "do lamb karahi", confidence: 0.95, needs_review: false, issues: [] },
      { item_id: s.items["Garlic Naan"].id, item_name: "Garlic Naan", variant_id: null, variant_name: null, quantity: 1, note: null,
        heard_text: "ek garlic naan", confidence: 0.5, needs_review: true, issues: ["not sure about this dish"] },
    ],
    unmatched: ["ek samosa chaat"],
    customer: { name: "Raj", phone: "+919876500123", phone_heard: "098765 00123" },
    order_type: "takeaway", table_label: null, table_id: null,
    ...extra,
  };
}

/** Mocks POST /ai/voice-order; returns the requests the page sent. */
async function mockVoice(page: Page, body: unknown) {
  const sent: Request[] = [];
  await page.route("**/api/v1/ai/voice-order", async (route) => {
    sent.push(route.request());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  return sent;
}

/** No microphone permission: getUserMedia is refused like a blocked site setting (and no live recogniser, like Firefox). */
const blockMic = (page: Page) => page.addInitScript(() => {
  for (const k of ["SpeechRecognition", "webkitSpeechRecognition"]) Object.defineProperty(window, k, { configurable: true, value: undefined });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
    getUserMedia: () => Promise.reject(new DOMException("Permission denied", "NotAllowedError")) } });
});

/** A fake microphone + MediaRecorder that produces a small webm blob on stop (and no live recogniser). */
const fakeMic = (page: Page) => page.addInitScript(() => {
  for (const k of ["SpeechRecognition", "webkitSpeechRecognition"]) Object.defineProperty(window, k, { configurable: true, value: undefined });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
    getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });
  class FakeRecorder {
    static isTypeSupported(t: string) { return t.startsWith("audio/webm"); }
    state = "inactive"; mimeType: string;
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    constructor(_s: unknown, o?: { mimeType?: string }) { this.mimeType = o?.mimeType ?? "audio/webm"; }
    start() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3])], { type: this.mimeType }) });
      setTimeout(() => this.onstop?.(), 0);
    }
  }
  (window as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeRecorder;
});

test("typed voice order (mic blocked): confirm sheet, fix lines, new customer, then place the order", async ({ page, request }) => {
  const s = await seedMenu(request, { serviceCharge: null });
  await blockMic(page);
  const sent = await mockVoice(page, reply(s));
  await openMenuPos(page, s);

  await page.getByRole("button", { name: "Voice order", exact: true }).click();
  const dlg = page.getByRole("dialog", { name: "Type the order" });
  await expect(dlg.getByText(/Microphone access is blocked/)).toBeVisible();
  // nothing here names a dish on this menu, so the on-device parser finds nothing and the AI is asked
  await dlg.getByLabel("Order").fill("wahi jo pichli baar Raj ne liya tha, number 098765 00123");
  await dlg.getByRole("button", { name: "Understand" }).click();

  const sheet = page.getByRole("dialog", { name: "Check the order" });
  await expect(sheet.getByTestId("voice-line")).toHaveCount(2);
  expect(sent).toHaveLength(1);
  expect(sent[0].postData()).toContain("wahi jo pichli baar");
  await expect(sheet.getByTestId("voice-source")).toHaveText(/^Understood by the server|^Checked with AI/);
  // nothing on the ticket yet
  await expect(page.getByRole("button", { name: /^Customer:/ })).toHaveCount(0);
  await expect(sheet.getByText("not sure about this dish")).toBeVisible();
  await expect(sheet.getByText(/extra spicy/)).toBeVisible();
  await expect(sheet.getByTestId("voice-unmatched")).toContainText("ek samosa chaat");
  await expect(sheet.getByLabel("Customer name")).toHaveValue("Raj");
  await expect(sheet.getByLabel("Customer phone")).toHaveValue("+919876500123");
  await expect(sheet.getByText("A new customer will be saved and selected.")).toBeVisible();

  // staff fix it: one more naan, drop the unmatched phrase
  await sheet.getByRole("button", { name: "Add one Garlic Naan" }).click();
  await sheet.getByRole("button", { name: "Drop “ek samosa chaat”" }).click();
  await expect(sheet.getByTestId("voice-unmatched")).toHaveCount(0);
  await sheet.getByRole("button", { name: "Add to order (4)" }).click();

  await expect(page.getByText(/4 items added to/)).toBeVisible();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole("button", { name: /^Customer: Raj/ })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Takeaway" })).toHaveAttribute("aria-checked", "true");
  const list = await customers(request, s);
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ name: "Raj", phone: "+919876500123" });

  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.getByRole("button", { name: "Make bill" })).toBeVisible();
  const [o] = await orders(request, s);
  expect(o.customer_id).toBe(list[0].id);
  expect(o.order_type).toBe("takeaway");
  const qty = Object.fromEntries(o.lines.map((l) => [l.item_id, [l.quantity, l.unit_price]]));
  expect(qty).toEqual({ [s.items["Lamb Karahi"].id]: [2, "8.50"], [s.items["Garlic Naan"].id]: [2, "3.00"] }); // menu prices
});

test("recorded voice order: recording state, audio upload, existing customer selected by phone, cancel adds nothing", async ({ page, request }) => {
  const s = await seedMenu(request, { serviceCharge: null });
  const existing = await (await request.post(`${API}/customers`, { headers: s.auth, data: { name: "Raj Kumar", phone: "098765 00123" } })).json();
  await fakeMic(page);
  const sent = await mockVoice(page, reply(s, { unmatched: [], customer: { name: "Raj", phone: "+919876500123", phone_heard: "098765 00123" } }));
  await openMenuPos(page, s);

  // cancel while recording: nothing sent, nothing added
  await page.getByRole("button", { name: "Voice order", exact: true }).click();
  let rec = page.getByRole("dialog", { name: "Listening" });
  await expect(rec.getByText("Recording")).toBeVisible();
  await expect(rec.getByTestId("voice-timer")).toContainText("/ 1:00");
  await expect(rec.getByText(/e\.g\. “2 chicken tikka masala/)).toBeVisible();
  await rec.getByRole("button", { name: "Cancel" }).click();
  await expect(rec).toBeHidden();
  expect(sent).toHaveLength(0);

  await page.getByRole("button", { name: "Voice order", exact: true }).click();
  rec = page.getByRole("dialog", { name: "Listening" });
  await rec.getByRole("button", { name: "Stop and check" }).click();
  const sheet = page.getByRole("dialog", { name: "Check the order" });
  await expect(sheet.getByTestId("voice-line")).toHaveCount(2);
  expect(sent).toHaveLength(1);
  expect(sent[0].headers()["content-type"]).toContain("multipart/form-data");
  expect(sent[0].postDataBuffer()!.toString("latin1")).toMatch(/filename="order\.webm"\r\nContent-Type: audio\/webm/);
  await expect(sheet.getByTestId("voice-source")).toHaveText(/^Checked with AI/);
  await expect(sheet.getByText("Existing customer: Raj Kumar will be selected.")).toBeVisible();

  // Cancel the sheet: the ticket stays empty
  await sheet.getByRole("button", { name: "Cancel" }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole("button", { name: /^Customer:/ })).toHaveCount(0);
  expect(await orders(request, s)).toHaveLength(0);

  await page.getByRole("button", { name: "Voice order", exact: true }).click();
  await page.getByRole("dialog", { name: "Listening" }).getByRole("button", { name: "Stop and check" }).click();
  await page.getByRole("dialog", { name: "Check the order" }).getByRole("button", { name: "Add to order (3)" }).click();
  await expect(page.getByRole("button", { name: /^Customer: Raj Kumar/ })).toBeVisible();
  expect(await customers(request, s)).toHaveLength(1); // no duplicate
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.getByRole("button", { name: "Make bill" })).toBeVisible();
  expect((await orders(request, s))[0].customer_id).toBe(existing.id);
});

test("voice ordering is disabled offline and says why", async ({ page, context, request }) => {
  const s = await seedMenu(request, { serviceCharge: null });
  // Chrome without an installed on-device English model (the real SpeechRecognition.available() crashes headless Chromium)
  await page.addInitScript(() => {
    const C = (window as unknown as { SpeechRecognition?: { available?: unknown } }).SpeechRecognition;
    if (C) C.available = async () => "downloadable";
  });
  const sent = await mockVoice(page, reply(s));
  await openMenuPos(page, s, { sw: true });
  const mic = page.getByRole("button", { name: /^Voice order/ });
  await expect(mic).toBeEnabled();
  await context.setOffline(true);
  await expect(page.getByRole("button", { name: "Voice order (needs internet)" })).toBeDisabled();
  await page.getByRole("button", { name: "Voice order (needs internet)" }).click({ force: true });
  await expect(page.getByText("Voice ordering needs an internet connection")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(sent).toHaveLength(0);
  await context.setOffline(false);
  await expect(page.getByRole("button", { name: "Voice order", exact: true })).toBeEnabled();
});
