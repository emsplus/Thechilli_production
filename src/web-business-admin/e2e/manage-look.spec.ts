import { expect, test } from "@playwright/test";
import { openAs, seedIn } from "./helpers";

// The original Karahi "Manage": a left "Manage" card (Overview, Menu, Tables, Customers, Recipes, Inventory, Suppliers & Purchases,
// Staff, Restaurant, Printers, System) beside the content; new screens live inside those sections. Shots go to SHOT_DIR.
test("Manage looks like the original: left Manage panel, Overview content, new screens inside their sections", async ({ page, request }) => {
  const s = await seedIn(request);
  await page.setViewportSize({ width: 1470, height: 790 });
  await openAs(page, s.token, "/manage", s.refresh);
  const rail = page.getByRole("navigation", { name: "Manage sections" });
  // Overview; Operations (the screens that left the sidebar, each with its own URL); Set up. Billing: Chilli credit (ux/wallet-reset-report)
  await expect(rail.getByRole("link")).toHaveText(["Overview", "Reservations", "Customers", "Reports", "Cash drawer", "End of day", "Menu", "Tables", "Reviews", "Recipes", "Inventory", "Staff", "Restaurant", "Billing", "Printers"]);
  await expect(rail.getByRole("heading", { level: 2 })).toHaveText(["Operations", "Set up"]);
  await expect(rail.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await expect(page.getByText(/^Hello, /)).toBeVisible();
  await expect(page.getByTestId("setup-card")).toBeVisible();
  for (const l of ["Menu items", "Categories", "Tables", "Stock items", "Suppliers", "Active staff"]) await expect(page.getByRole("link", { name: new RegExp(l) }).first()).toBeVisible();
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/manage-overview-1470x790.png` });

  // old routes land inside their section
  await page.goto("/modifiers");
  await expect(page).toHaveURL(/tab=menu&view=modifiers/);
  await expect(rail.getByRole("link", { name: "Menu" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("radio", { name: "Modifier groups" }).or(page.getByRole("tab", { name: "Modifier groups" })).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Add group" }).first()).toBeVisible();
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/manage-menu-modifiers-1470x790.png` });
  await page.goto("/offers");
  await expect(page).toHaveURL(/tab=menu&view=offers/);
  await expect(page.getByTestId("active-offers")).toBeVisible();
  await page.goto("/attendance");
  await expect(page).toHaveURL(/tab=staff&view=attendance/);
  await expect(page.getByTestId("clocked-in")).toBeVisible();
  await page.goto("/manage?tab=outlets");
  await expect(rail.getByRole("link", { name: "Restaurant" })).toHaveAttribute("aria-current", "page");
  const sw = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(sw).toBeLessThanOrEqual(0);
});
