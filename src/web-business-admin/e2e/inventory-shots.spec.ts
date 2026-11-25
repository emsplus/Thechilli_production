import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { openAs } from "./helpers";
import { noHScroll, overflowing, seedActivity, seedInventory, setTheme, smallTargets } from "./inventory-helpers";

// Visual tour of every inventory / stock / procurement screen at 1280 and 390 px, light and dark, against the real API.
// Screenshots go to docs/inventory-ui-shots/ (INVENTORY_SHOTS=0 turns them off); the layout checks always run.
const SHOTS = process.env.INVENTORY_SHOTS !== "0";
const DIR = "docs/inventory-ui-shots";
const SCREENS: [string, string][] = [
  ["stock-levels", "/manage?tab=inventory"],
  ["recipes", "/manage?tab=recipes"],
  ["suppliers", "/manage?tab=suppliers"],
  ["invoices", "/manage?tab=suppliers&view=invoices"],
  ["po", "/procurement?tab=orders"],
  ["grn", "/procurement?tab=receipts"],
  ["wastage", "/procurement?tab=wastage"],
  ["batches", "/procurement?tab=batches"],
  ["counts", "/procurement?tab=counts"],
  ["locations", "/procurement?tab=locations"],
  ["alerts", "/alerts"],
  ["food-cost", "/reports"],
];
const VARIANTS = [
  { name: "1280-light", w: 1280, h: 800, theme: "light" as const }, { name: "1280-dark", w: 1280, h: 800, theme: "dark" as const },
  { name: "390-light", w: 390, h: 844, theme: "light" as const }, { name: "390-dark", w: 390, h: 844, theme: "dark" as const },
];

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

for (const v of VARIANTS) {
  test(`tour ${v.name}`, async ({ page, request }) => {
    mkdirSync(DIR, { recursive: true });
    const s = await seedInventory(request);
    await seedActivity(request, s);
    await page.setViewportSize({ width: v.w, height: v.h });
    await setTheme(page, v.theme);
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    await openAs(page, s.token, "/manage?tab=inventory", s.refresh);
    for (const [name, path] of SCREENS) {
      await page.goto(path);
      if (name === "food-cost") await page.getByRole("tab", { name: "Food cost" }).click();
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(600);
      const over = await noHScroll(page);
      if (over > 0) problems.push(`${name}: page scrolls sideways by ${over}px`);
      for (const o of (await overflowing(page)).slice(0, 3)) problems.push(`${name}: sticks out: ${o}`);
      const small = await smallTargets(page);
      if (small.length) problems.push(`${name}: ${small.length} small targets: ${small.slice(0, 6).join("; ")}`);
      // axe on a screen WITH data (lists, badges, tables): contrast and labels of the real rows, serious / critical only
      const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      for (const x of axe.violations.filter((a) => a.impact === "serious" || a.impact === "critical")) problems.push(`${name}: axe ${x.id} (${x.impact}) ${x.nodes.length}x: ${x.nodes[0]?.target.join(" ")}`);
      if (SHOTS) {
        // A viewport as tall as the page (not fullPage): fixed bars (side menu, bottom tab bar) then sit where a user sees them.
        const h = Math.min(3000, Math.max(v.h, await page.evaluate(() => document.documentElement.scrollHeight)));
        await page.setViewportSize({ width: v.w, height: h });
        await page.waitForTimeout(150);
        await page.screenshot({ path: `${DIR}/${name}-${v.name}.png` });
        await page.setViewportSize({ width: v.w, height: v.h });
      }
    }

    // The forms people actually fill in, open: a dialog must fit the phone and keep its buttons reachable.
    const shot = async (name: string) => {
      const dlg = page.getByRole("dialog").last();
      await expect(dlg).toBeVisible();
      await page.waitForTimeout(300);
      const box = await dlg.boundingBox();
      if (box && (box.x < -1 || box.x + box.width > v.w + 1)) problems.push(`${name}: dialog is ${Math.round(box.x)}..${Math.round(box.x + box.width)} wide in a ${v.w}px viewport`);
      for (const o of (await overflowing(page)).slice(0, 2)) problems.push(`${name}: sticks out: ${o}`);
      const small = await smallTargets(page);
      if (small.length) problems.push(`${name}: ${small.length} small targets: ${small.slice(0, 6).join("; ")}`);
      if (SHOTS) await page.screenshot({ path: `${DIR}/${name}-${v.name}.png` });
      await page.keyboard.press("Escape");
      await expect(dlg).toBeHidden();
    };
    await page.goto("/procurement?tab=orders"); await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "New purchase order" }).first().click();
    await page.getByRole("dialog").getByLabel("Supplier").selectOption({ label: "Sharma Dairy" });
    await page.getByRole("dialog").getByLabel("Item 1", { exact: true }).selectOption({ label: "Paneer" });
    await shot("dlg-po-new");
    await page.getByRole("button", { name: "Receive goods" }).first().click();
    await shot("dlg-receive");
    await page.getByRole("button", { name: "View" }).first().click();
    await shot("dlg-po-detail");
    await page.goto("/manage?tab=inventory"); await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Add item", exact: true }).click();
    await shot("dlg-add-item");
    await page.getByRole("button", { name: "Stock count", exact: true }).click();
    await shot("dlg-stock-count");
    await page.getByRole("button", { name: "Wastage / adjust" }).click();
    await shot("dlg-adjust");
    await page.getByRole("button", { name: "Ledger for Paneer" }).click();
    await shot("dlg-ledger");
    await page.goto("/procurement?tab=wastage"); await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Record wastage" }).click();
    await shot("dlg-wastage");
    await page.goto("/manage?tab=recipes"); await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: /Paneer Tikka/ }).click();
    await page.waitForTimeout(500);
    if (SHOTS) { const h = Math.min(3000, await page.evaluate(() => document.documentElement.scrollHeight)); await page.setViewportSize({ width: v.w, height: Math.max(v.h, h) }); await page.screenshot({ path: `${DIR}/recipe-editor-${v.name}.png` }); await page.setViewportSize({ width: v.w, height: v.h }); }
    for (const o of (await overflowing(page)).slice(0, 3)) problems.push(`recipe-editor: sticks out: ${o}`);
    // sandbox: layout problems fail the run (the side-menu "Sync" link is the shell's, 40 px tall on a desktop pointer)
    const real = problems.filter((x) => !/^\w[\w-]*: \d+ small targets: (a "Sync" 210x40|a "Skip to content" 1x1)$/.test(x));
    console.log(`[${v.name}]\n` + problems.join("\n"));
    expect(real, "layout problems").toEqual([]);
  });
}
