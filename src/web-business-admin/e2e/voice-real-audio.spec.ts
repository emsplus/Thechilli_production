import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { openAs } from "./helpers";
import { seedOwner } from "./voice-qa-harness";

/**
 * REAL audio (owner, 2026-11-02): Chromium's fake microphone plays a wav made with the macOS `say` voices, so the OFFLINE wake
 * detector (Vosk in WebAssembly, lib/wakeDetector.ts) hears real sound, not the scripted recogniser. Chromium's own cloud
 * recogniser does not work in a test browser, so after the wake the order words come from the server speech-to-text (mocked
 * here with the words that were said). docs/VOICE_QA_REPORT.md "Offline detector".
 */
const FIX = path.join(__dirname, "fixtures", "voice");
const reply = (transcript: string) => ({ transcript, lines: [], unmatched: [], clarifications: [], needs_clarification: false, customer: { name: null, phone: null, phone_heard: null }, order_type: null, table_label: null, table_id: null, command: null, model_used: false });
const log = (page: Page) => page.getByTestId("mic-debug-log");

async function open(page: Page, context: import("@playwright/test").BrowserContext, request: import("@playwright/test").APIRequestContext) {
  const m = await seedOwner(request);
  await context.grantPermissions(["microphone"]);
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log(`[browser ${m.type()}] ${m.text().slice(0, 300)}`); });
  page.on("pageerror", (e) => console.log(`[pageerror] ${e.message.slice(0, 300)}`));
  await page.addInitScript(() => { localStorage.setItem("pos.micDebug", "1"); localStorage.setItem("pos.micDebugOpen", "1"); localStorage.setItem("pos.voiceDirect", "0"); localStorage.removeItem("pos.wakeOff"); });
  await page.route("**/api/v1/ai/voice-order", (r) => r.fulfill({ json: reply("Hey Zonov. One lassi please.") }));
  await openAs(page, m.token, "/pos", m.refresh);
  await expect(page.getByRole("button", { name: /^Matar Paneer,/ }).first()).toBeVisible();
  await expect(log(page)).toContainText(/wake detector: (ready|failed)/, { timeout: 120_000 });
  await expect(log(page)).toContainText("wake detector: ready");
}

// One wav per run (Chromium takes the fake microphone file at launch): VOICE_WAV=wake_Rishi.wav | wake_Lekha.wav | wake_Samantha.wav
// | wake_Daniel.wav (expects a wake) or neg_Rishi.wav (expects none). Default: wake_Rishi.wav.
const WAV = process.env.VOICE_WAV ?? "wake_Rishi.wav";
const EXPECT_WAKE = WAV.startsWith("wake_");
test.use({ viewport: { width: 1280, height: 800 }, launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${path.join(FIX, WAV)}`] } });

if (EXPECT_WAKE) {
  test(`real audio ${WAV}: 'Hey Zonov. One lassi please.' is detected offline and the order opens`, async ({ page, context, request }) => {
    test.setTimeout(180_000);
    await open(page, context, request);
    await expect(log(page)).toContainText("WAKE by the offline detector", { timeout: 60_000 });
    await expect(page.getByRole("dialog").getByTestId("voice-line").first()).toContainText("Sweet Lassi", { timeout: 30_000 });
  });
} else {
  test(`real audio ${WAV}: 60 s of looped everyday talk, no wake from the offline detector`, async ({ page, context, request }) => {
    test.setTimeout(240_000);
    await open(page, context, request);
    await page.waitForTimeout(60_000);
    await expect(log(page)).not.toContainText("WAKE by the offline detector");
  });
}
