import { test } from "@playwright/test";
import { openAs } from "./helpers";
import { overflowing, seedActivity, seedInventory } from "./inventory-helpers";
const PATHS = (process.env.PROBE_PATHS ?? "/manage?tab=inventory").split(",");
test("probe", async ({ page, request }) => {
  const s = await seedInventory(request); await seedActivity(request, s);
  await page.setViewportSize({ width: Number(process.env.PROBE_W ?? 390), height: 844 });
  await openAs(page, s.token, PATHS[0], s.refresh);
  for (const p of PATHS) { await page.goto(p); await page.waitForLoadState("networkidle"); await page.waitForTimeout(500); console.log(p + "\n  " + (await overflowing(page)).join("\n  ")); }
});
