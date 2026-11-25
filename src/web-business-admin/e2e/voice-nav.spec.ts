import { expect, test } from "@playwright/test";
import { openAs } from "./helpers";
import { installHarness, qa, seedOwner } from "./voice-qa-harness";

// Owner, 2026-11-02: "the mic shows it started but does not hear Hey Zonov; a HARD refresh fixes it". The order screen reached
// by CLIENT-SIDE navigation (sidebar links) must start hands-free exactly like a fresh load, every time.
test("10 client-side trips away from the order screen and back: hands-free really starts and hears Hey Zonov each time", async ({ page, context, request }) => {
  test.setTimeout(10 * 60_000);
  const m = await seedOwner(request);
  await context.grantPermissions(["microphone"]);
  await installHarness(page, { handsFree: true, silenceMs: 4000 });
  await openAs(page, m.token, "/pos", m.refresh);
  const nav = page.getByRole("navigation").first();
  const status = page.getByTestId("auto-status");
  for (let i = 0; i < 10; i++) {
    const away = ["Orders", "Kitchen", "Inventory", "Manage", "Orders"][i % 5]; // the sidebar is Chilli Agent, Orders, Kitchen, Inventory, Manage
    if (i > 0) {
      await nav.getByRole("link", { name: away, exact: true }).first().click();
      await expect(page).not.toHaveURL(/\/pos$/);
      await nav.getByRole("link", { name: "Chilli Agent", exact: true }).first().click();
      await expect(page).toHaveURL(/\/pos/);
    }
    await expect(page.getByRole("button", { name: /^Matar Paneer,/ }).first()).toBeVisible();
    await expect.poll(() => qa(page, "newestListening"), { timeout: 20_000, message: `trip ${i}: a recogniser is listening` }).toBe(true);
    await expect(status, `trip ${i}: waiting only after Chrome really started`).toHaveText(/Waiting for “Hey Zonov”/, { timeout: 20_000 });
    expect(await qa(page, "listening"), `trip ${i}: one recogniser`).toBe(1);
    await qa(page, "final", "hey zonov");
    await expect(page.getByRole("dialog"), `trip ${i}: Hey Zonov heard`).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
});

test("the chip says Starting… until Chrome really starts (no onstart / audiostart = not Listening), then recreates within 2 s", async ({ page, context, request }) => {
  const m = await seedOwner(request);
  await context.grantPermissions(["microphone"]);
  await installHarness(page, { handsFree: true });
  await page.addInitScript(() => { (window as unknown as { __qaNoStartFirst: boolean }).__qaNoStartFirst = true; });
  await openAs(page, m.token, "/pos", m.refresh);
  await expect(page.getByRole("button", { name: /^Matar Paneer,/ }).first()).toBeVisible();
  await expect(page.getByTestId("hands-free")).toHaveAccessibleName("Hands-free “Hey Zonov”: Starting…");
  await expect(page.getByTestId("auto-status")).not.toHaveText(/Waiting for “Hey Zonov”/);
  await expect(page.getByTestId("hands-free")).toHaveAccessibleName("Hands-free “Hey Zonov”: Listening", { timeout: 8000 });
  expect(await qa(page, "count")).toBeGreaterThanOrEqual(2); // the silent one was destroyed and recreated
  await qa(page, "final", "hey zonov");
  await expect(page.getByRole("dialog")).toBeVisible();
});
