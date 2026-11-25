import { expect, test, type Page } from "@playwright/test";
import { deflateSync } from "node:zlib";
import { API, seed, seedIn, signIn, type Seed } from "./helpers";

/** A valid solid-colour PNG, built in memory (no fixture files). */
function makePng(w = 64, h = 48, rgb: [number, number, number] = [201, 71, 12]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

async function openAs(page: Page, token: string, path: string, refresh = "") {
  await signIn(page, token, refresh || undefined);
  await page.goto(path);
}

const items = async (request: import("@playwright/test").APIRequestContext, s: Seed, q = "") =>
  (await (await request.get(`${API}/menu/items${q}`, { headers: s.auth })).json()) as { id: string; name: string; price: string; image_url: string | null; thumb_url: string | null; is_active: boolean }[];

test("owner adds a category and an item with a photo, edits the price, archives and restores it", async ({ page, request }) => {
  const s = await seed(request);
  await openAs(page, s.token, "/manage?tab=menu", s.refresh);
  await expect(page.getByRole("button", { name: "Edit Latte" })).toBeVisible();

  // New category through the categories sheet
  await page.getByRole("button", { name: "Manage categories" }).click();
  await page.getByLabel("New category name").fill("Desserts");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("button", { name: "Rename Desserts" })).toBeVisible();
  await page.keyboard.press("Escape");

  // New item with a photo
  await page.getByRole("button", { name: "Add item" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Photo file").setInputFiles({ name: "brownie.png", mimeType: "image/png", buffer: makePng() });
  await expect(dialog.getByText(/New photo/)).toBeVisible();
  await dialog.getByLabel("Name").fill("Brownie");
  await dialog.getByLabel("Category").selectOption({ label: "Desserts" });
  await dialog.getByLabel("Price (₹)").fill("9.50");
  await dialog.getByRole("button", { name: "Add item" }).click();

  const card = page.getByRole("listitem").filter({ hasText: "Brownie" });
  await expect(card.locator("img")).toHaveAttribute("src", /\/media\/menu\//);
  await expect.poll(() => card.locator("img").evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
  const brownie = (await items(request, s)).find((i) => i.name === "Brownie")!;
  expect(brownie.image_url).toContain("/media/menu/");
  expect(brownie.thumb_url).toContain("/media/menu/");

  // Edit the price
  await page.getByRole("button", { name: "Edit Brownie" }).click();
  await dialog.getByLabel("Price (₹)").fill("11.00");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(async () => (await items(request, s)).find((i) => i.name === "Brownie")?.price).toBe("11.00");
  expect((await items(request, s)).find((i) => i.name === "Brownie")?.image_url).toBeTruthy(); // photo survives an edit

  // Archive: gone from the POS menu API
  await page.getByRole("button", { name: "Archive Brownie" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Archive", exact: true }).click(); // @chilli/ui ConfirmDialog is an alertdialog
  await expect.poll(async () => (await items(request, s)).some((i) => i.name === "Brownie")).toBe(false);
  expect((await items(request, s, "?include_inactive=true")).some((i) => i.name === "Brownie" && !i.is_active)).toBe(true);

  // Restore
  await page.getByLabel(/Show archived items/).check();
  await page.getByRole("button", { name: "Restore Brownie" }).click();
  await expect.poll(async () => (await items(request, s)).some((i) => i.name === "Brownie")).toBe(true);
});

test("a bad photo is refused with a friendly message", async ({ page, request }) => {
  const s = await seed(request);
  await openAs(page, s.token, "/manage?tab=menu", s.refresh);
  await page.getByRole("button", { name: "Edit Latte" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Photo file").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await expect(dialog.getByText("Use a JPG, PNG or WebP photo.")).toBeVisible();
  expect((await items(request, s))[0].image_url).toBeNull();
});

test("owner adds a cashier, changes the role and deactivates the account", async ({ page, request }) => {
  const s = await seed(request);
  const email = `cara-${Date.now()}@example.in`;
  await openAs(page, s.token, "/manage?tab=staff", s.refresh);
  await page.getByRole("button", { name: "Add staff" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Full name").fill("Cara Cashier");
  await dialog.getByLabel("Email (optional)").fill(email);
  await dialog.getByLabel(/^Cashier/).check();
  await dialog.getByRole("button", { name: "Add staff" }).click();
  // the one-time sign-in card (restaurant code, login id, one-time password) is shown once
  await expect(page.getByTestId("cred-password")).not.toBeEmpty();
  await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();
  await expect(page.getByText("Cara Cashier").first()).toBeVisible();
  const users = async () => (await (await request.get(`${API}/auth/users`, { headers: s.auth })).json()) as { email: string; role: string; is_active: boolean }[];
  await expect.poll(async () => (await users()).find((u) => u.email === email)?.role).toBe("cashier");

  await page.getByRole("button", { name: "Change role for Cara Cashier" }).click();
  await page.getByRole("dialog").getByLabel(/^Waiter/).check();
  await page.getByRole("dialog").getByRole("button", { name: "Save role" }).click();
  await expect.poll(async () => (await users()).find((u) => u.email === email)?.role).toBe("waiter");

  await page.getByRole("button", { name: "Deactivate Cara Cashier" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Deactivate", exact: true }).click();
  await expect.poll(async () => (await users()).find((u) => u.email === email)?.is_active).toBe(false);
});

test("restaurant profile edits persist (India: GSTIN, GST wording, rupees)", async ({ page, request }) => {
  const s = await seedIn(request);
  await openAs(page, s.token, "/manage?tab=restaurant", s.refresh);
  await page.getByLabel("Restaurant name").fill("Renamed Dhaba");
  await page.getByLabel(/^GSTIN/).fill("29ABCDE1234F1Z5");
  await page.getByLabel("Address").fill("12 MG Road, Bengaluru");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(async () => (await (await request.get(`${API}/restaurant`, { headers: s.auth })).json()).name).toBe("Renamed Dhaba");
  const r = await (await request.get(`${API}/restaurant`, { headers: s.auth })).json();
  expect(r).toMatchObject({ trn: "29ABCDE1234F1Z5", address: "12 MG Road, Bengaluru" });
  await page.reload();
  await expect(page.getByLabel("Restaurant name")).toHaveValue("Renamed Dhaba");
  await page.getByLabel(/^GSTIN/).fill("123");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText(/A GSTIN has 15 characters/)).toBeVisible();
  await expect(page.getByText(/\bVAT\b|\bTRN\b|AED|£/)).toHaveCount(0);
});

test("a cashier keeps Customers and Cash drawer through Manage (only their entries), and the kitchen role gets the friendly screen", async ({ page, request }) => {
  const s = await seed(request);
  const email = `cashier-${Date.now()}@example.in`;
  const made = await request.post(`${API}/auth/users`, { headers: s.auth, data: { email, full_name: "Casey", password: "Samosa-and-chai-26", role: "cashier" } });
  expect(made.status()).toBe(201);
  const pair = await (await request.post(`${API}/auth/login`, { data: { email, password: "Samosa-and-chai-26" } })).json();

  const me = page.waitForResponse((r) => r.url().endsWith("/auth/me") && r.ok());
  await openAs(page, pair.access_token, "/pos", pair.refresh_token);
  await me;
  const side = page.getByRole("complementary", { name: "Primary" });
  await expect(side.locator("nav").getByRole("link")).toHaveText(["Chilli Agent", "Orders", "Kitchen", "Manage"]); // no Inventory; Manage holds their Customers / Cash drawer (a cashier has no reports.view)

  await side.getByRole("link", { name: "Manage", exact: true }).click();
  await expect(page).toHaveURL(/\/customers$/); // the first screen they may use, with Manage's navigation beside it
  const rail = page.getByRole("navigation", { name: "Manage sections" });
  await expect(rail.getByRole("link")).toHaveText(["Customers", "Cash drawer"]);
  await rail.getByRole("link", { name: "Cash drawer" }).click();
  await expect(page).toHaveURL(/\/cash$/);
  await expect(side.getByRole("link", { name: "Manage", exact: true })).toHaveAttribute("aria-current", "page");
  // the owner-only tabs are not theirs: /manage?tab=menu sends them to their own screens, never to the menu editor
  await page.goto("/manage?tab=menu");
  await expect(page).toHaveURL(/\/customers$/);

  // a kitchen account has no Manage entry at all
  const kemail = `kitchen-${Date.now()}@example.in`;
  expect((await request.post(`${API}/auth/users`, { headers: s.auth, data: { email: kemail, full_name: "Kit", password: "Samosa-and-chai-26", role: "kitchen" } })).status()).toBe(201);
  const kpair = await (await request.post(`${API}/auth/login`, { data: { email: kemail, password: "Samosa-and-chai-26" } })).json();
  await openAs(page, kpair.access_token, "/manage", kpair.refresh_token);
  await expect(page.getByRole("heading", { name: "Ask the owner or manager" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Manage" })).toHaveCount(0);
});

test("old back-office URLs redirect into the Manage panel", async ({ page, request }) => {
  const s = await seed(request);
  await openAs(page, s.token, "/menu", s.refresh);
  await expect(page).toHaveURL(/\/manage\?tab=menu$/);
  await expect(page.getByRole("button", { name: "Edit Latte" })).toBeVisible();
  for (const [from, to] of [["/inventory", /tab=inventory$/], ["/recipes", /tab=recipes$/], ["/purchases", /tab=suppliers&view=invoices$/]] as const) {
    await page.goto(from);
    await expect(page).toHaveURL(to);
  }
  // Suppliers & Purchases is not listed in the Manage navigation any more (owner 2026-11-13); the page itself opened above
  await expect(page.getByRole("link", { name: "Suppliers & Purchases" })).toHaveCount(0);
});
