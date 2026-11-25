import { expect, test, type Page } from "@playwright/test";
import { openAs } from "./helpers";
import { seedOwner } from "./voice-qa-harness";

/**
 * The offline wake detector's model on a fresh device, against the PRODUCTION build with the page CSP in force (owner,
 * 2026-11-02: "after a fresh deploy, does /voice-models load on the first hands-free start?"). Chromium's fake microphone
 * (a tone) gives the mic stream; the cloud recogniser plays no part here.
 *  1. fresh device: the model (37.5 MB) and the worker are fetched once, with the immutable cache header; "Loading voice engine"
 *     shows while it downloads (the download is slowed down here so the chip is seen); the detector gets ready; no CSP violation.
 *  2. the next start: the model comes from the device's Cache API (no download), ready again.
 *  3. the model cannot be fetched (404): "wake detector: failed (...; the Web Speech wake path stays on)", the chip goes, the
 *     till keeps working.
 */
const MODEL = "**/voice-models/vosk-model-small-en-in-0.4.tar.gz";
const log = (page: Page) => page.getByTestId("mic-debug-log");
test.use({ viewport: { width: 1280, height: 800 }, launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] } });

async function start(page: Page, context: import("@playwright/test").BrowserContext, token: string, refresh: string) {
  await context.grantPermissions(["microphone"]);
  await page.addInitScript(() => {
    localStorage.setItem("pos.micDebug", "1"); localStorage.setItem("pos.micDebugOpen", "1"); localStorage.setItem("pos.voiceDirect", "0"); localStorage.removeItem("pos.wakeOff");
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  await openAs(page, token, "/pos", refresh);
  await expect(page.getByRole("button", { name: /^Matar Paneer,/ }).first()).toBeVisible();
}
const csp = (page: Page) => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);

test("fresh device: the model loads on the first hands-free start under the page CSP, the chip shows, the next start uses the device cache", async ({ page, context, request }) => {
  test.setTimeout(240_000);
  const m = await seedOwner(request);
  const fetched: { url: string; status: number; cache: string | null; type: string | null; len: string | null }[] = [];
  page.on("response", (r) => { if (r.url().includes("/voice-models/")) fetched.push({ url: r.url().replace(/^.*\/voice-models\//, ""), status: r.status(), cache: r.headers()["cache-control"] ?? null, type: r.headers()["content-type"] ?? null, len: r.headers()["content-length"] ?? null }); });
  // a slow connection: the model answers after 4 s, so "Loading voice engine" is on screen meanwhile
  await page.route(MODEL, async (r) => { await new Promise((ok) => setTimeout(ok, 4000)); await r.continue(); });
  await start(page, context, m.token, m.refresh);
  await expect(page.getByTestId("voice-engine-loading")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("voice-engine-loading")).toContainText("Loading voice engine");
  await expect(log(page)).toContainText(/wake detector: (ready|failed)/, { timeout: 120_000 });
  await expect(log(page)).toContainText("wake detector: ready");
  await expect(page.getByTestId("voice-engine-loading")).toHaveCount(0);
  expect(await csp(page)).toEqual([]);
  const model = fetched.find((f) => f.url.startsWith("vosk-model"));
  const worker = fetched.find((f) => f.url.startsWith("vosk-worker"));
  expect(model).toMatchObject({ status: 200, cache: "public, max-age=31536000, immutable", type: "application/gzip", len: "37562533" });
  expect(worker).toMatchObject({ status: 200, cache: "public, max-age=31536000, immutable" });
  expect(worker!.type).toContain("javascript");

  // next start on this device: no model download (Cache API "voice-models-v1"), ready again
  await page.unroute(MODEL);
  let downloads = 0;
  page.on("request", (r) => { if (r.url().includes("vosk-model-small")) downloads++; });
  await page.reload();
  await expect(page.getByRole("button", { name: /^Matar Paneer,/ }).first()).toBeVisible();
  await expect(log(page)).toContainText("wake detector: ready", { timeout: 120_000 });
  expect(downloads).toBe(0);
  expect(await csp(page)).toEqual([]);
});

test("the model cannot be fetched: the detector says it failed, the chip goes, the till and hands-free keep working", async ({ page, context, request }) => {
  test.setTimeout(180_000);
  const m = await seedOwner(request);
  await page.route(MODEL, (r) => r.fulfill({ status: 404, body: "not found" }));
  await start(page, context, m.token, m.refresh);
  await expect(log(page)).toContainText(/wake detector: failed \(.*the Web Speech wake path stays on\)/, { timeout: 60_000 });
  await expect(page.getByTestId("voice-engine-loading")).toHaveCount(0);
  expect(await csp(page)).toEqual([]);
  // the till itself is untouched: a dish still goes on the bill by tap
  await page.getByRole("button", { name: /^Matar Paneer,/ }).first().click();
  await expect(page.getByRole("button", { name: /^Remove one Matar Paneer|^Decrease Matar Paneer/ }).or(page.getByText("Matar Paneer").nth(1)).first()).toBeVisible();
});
