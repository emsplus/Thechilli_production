import { expect, test } from "@playwright/test";
import { openAs } from "./helpers";
import { installHarness, qa, seedOwner } from "./voice-qa-harness";

// Owner report 2026-11-02 (docs/VOICE_QA_REPORT.md B18): is hands-free torn down and recreated while staff just sit on the order
// screen? Every recreate is a deaf gap. Default timings (no shortened watchdog), 45 s idle, then a cart change and toasts.
test("idle on the order screen: one recogniser, never recreated; wake-config read once", async ({ page, context, request }) => {
  test.setTimeout(180_000);
  const m = await seedOwner(request);
  await context.grantPermissions(["microphone"]);
  await installHarness(page, { handsFree: true });
  const cfg: string[] = [];
  await page.route("**/api/v1/voice/wake-config", (r) => { cfg.push(r.request().url()); return r.fulfill({ status: 404, body: "" }); });
  await openAs(page, m.token, "/pos", m.refresh);
  await expect(page.getByRole("button", { name: /^Matar Paneer,/ }).first()).toBeVisible();
  await expect.poll(() => qa(page, "listening"), { timeout: 20_000 }).toBe(1);
  const n0 = await qa(page, "count");
  await page.waitForTimeout(45_000);
  expect(await qa(page, "count"), "recognisers created while idle").toBe(n0);
  // ordinary use around it: a tap on a dish (cart changes, busy flags), a toast
  await page.getByRole("button", { name: /^Matar Paneer,/ }).first().click();
  await page.waitForTimeout(3000);
  expect(await qa(page, "count"), "recognisers created by a cart change").toBe(n0);
  expect(await qa(page, "listening")).toBe(1);
  expect(cfg.length, "wake-config requests").toBeLessThanOrEqual(1);
});
