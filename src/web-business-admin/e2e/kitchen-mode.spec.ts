import { expect, test } from "@playwright/test";
import { API, openAs, seed, setKitchenMode, signIn } from "./helpers";

// Kitchen routing (docs/UX_WALKTHROUGH.md "Kitchen: implemented answer"): the kitchen role gets the full-screen kiosk; owner and
// manager open the board inside the normal shell and can switch to full screen and back.

async function kitchenUser(request: Parameters<typeof seed>[0], auth: Record<string, string>) {
  const email = `kds-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.in`;
  expect((await request.post(`${API}/auth/users`, { headers: auth, data: { email, full_name: "Chef", password: "supersecret123", role: "kitchen" } })).ok()).toBeTruthy();
  const pair = await (await request.post(`${API}/auth/login`, { data: { email, password: "supersecret123" } })).json();
  return pair as { access_token: string; refresh_token: string };
}

async function ticket(request: Parameters<typeof seed>[0], s: Awaited<ReturnType<typeof seed>>) {
  const o = await (await request.post(`${API}/orders`, { headers: s.auth, data: { client_uuid: crypto.randomUUID(), order_type: "takeaway", lines: [{ item_id: s.itemId, quantity: 2 }] } })).json();
  expect((await request.post(`${API}/orders/${o.id}/kot`, { headers: s.auth })).ok()).toBeTruthy();
}

test("kitchen user: full-screen kiosk without navigation; a tap advances the ticket", async ({ page, request }) => {
  const s = await seed(request);
  await setKitchenMode(request, s.auth, "track"); // the Preparing / Ready / Served workflow (the default is KOT only: e2e/kot-only-kitchen.spec.ts)
  await ticket(request, s);
  const k = await kitchenUser(request, s.auth);
  await openAs(page, k.access_token, "/kitchen", k.refresh_token);
  await expect(page.getByTestId("kitchen")).toHaveAttribute("data-mode", "kiosk");
  await expect(page.getByRole("navigation", { name: "Primary" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Full screen" })).toHaveCount(0);   // the kitchen role cannot leave the kiosk
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await page.getByRole("button", { name: "Start preparing" }).first().click();
  await expect(page.getByRole("button", { name: "Mark ready" }).first()).toBeVisible();
});

test("owner: the kitchen board opens inside the shell, with a Full screen toggle and a way back", async ({ page, request }) => {
  const s = await seed(request);
  await ticket(request, s);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openAs(page, s.token, "/kitchen", s.refresh);
  await expect(page.getByTestId("kitchen")).toHaveAttribute("data-mode", "shell");
  await expect(page.getByRole("link", { name: "Chilli Agent", exact: true }).first()).toBeVisible();           // the sidebar is there
  await page.getByRole("button", { name: "Full screen" }).click();
  await expect(page.getByTestId("kitchen")).toHaveAttribute("data-mode", "kiosk");
  await expect(page.getByRole("link", { name: "Chilli Agent", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Exit full screen" }).click();
  await expect(page.getByTestId("kitchen")).toHaveAttribute("data-mode", "shell");
  await expect(page.getByRole("link", { name: "Chilli Agent", exact: true }).first()).toBeVisible();
});

// UI_REVIEW BA-12: wall tablets in landscape. All three status columns side by side and fully on screen (no page scroll),
// large ticket text; in the shell the sidebar is an icon rail (not 25% of the screen) below 1280 px.
for (const [w, h] of [[1024, 768], [1280, 800]] as const) {
  test(`wall tablet ${w}x${h}: Pending, Preparing and Ready all visible, no page scroll (kiosk and shell)`, async ({ page, request }) => {
    const s = await seed(request);
    await setKitchenMode(request, s.auth, "track"); // three status columns
    for (let i = 0; i < 9; i++) await ticket(request, s); // more tickets than fit: the columns scroll inside themselves
    const k = await kitchenUser(request, s.auth);
    await page.setViewportSize({ width: w, height: h });
    const check = async () => {
      for (const name of [/^Pending/, /^Preparing/, /^Ready/]) {
        const col = page.getByRole("heading", { name, level: 2 });
        await expect(col).toBeInViewport({ ratio: 1 });
      }
      const tops = await page.locator(".ch-kds-col").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
      expect(new Set(tops).size, "columns side by side").toBe(1);
      const board = await page.getByTestId("kitchen-board").boundingBox();
      expect(board!.y + board!.height).toBeLessThanOrEqual(h + 1);
      expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight), "page scroll").toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
      const px = await page.locator(".ch-kds-ticket__items").first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
      expect(px, "ticket item text size").toBeGreaterThanOrEqual(20);
    };
    await openAs(page, k.access_token, "/kitchen", k.refresh_token);
    await expect(page.getByTestId("kitchen")).toHaveAttribute("data-mode", "kiosk");
    await expect(page.getByTestId("kot-ticket").first()).toBeVisible();
    await check();
    // The owner in the shell: the sidebar is narrow (rail below 1280, never a quarter of the screen).
    await signIn(page, s.token, s.refresh);
    await page.evaluate(() => localStorage.removeItem("pos.kds.fullscreen"));
    await page.goto("/kitchen");
    await expect(page.getByTestId("kitchen")).toHaveAttribute("data-mode", "shell");
    await expect(page.getByTestId("kot-ticket").first()).toBeVisible();
    const side = await page.getByRole("complementary", { name: "Primary" }).boundingBox();
    expect(side!.width, "sidebar width").toBeLessThanOrEqual(w < 1280 ? 80 : 0.21 * w);
    await expect(page.getByRole("link", { name: "Chilli Agent", exact: true }).first()).toBeVisible(); // rail keeps an accessible name
    await check();
  });
}
