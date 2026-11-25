import { expect, test, type Locator, type Page } from "@playwright/test";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { API, openAs, seed } from "./helpers";

/** Phone owner photographs a two-page supplier bill and sends it as ONE purchase. */
test.use({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });

/** A valid solid-colour PNG, built in memory (no fixture files). */
function makePng(rgb: [number, number, number], w = 120, h = 160): Buffer {
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

/** No horizontal page scroll, and nothing poking out of the screen (the body clips overflow, so scrollWidth alone can hide it).
 * Content inside its own horizontal scroller (section pills, wide tables) is fine. */
const noSideScroll = (page: Page) => page.evaluate(() => {
  if (document.documentElement.scrollWidth > window.innerWidth) return false;
  const scrolls = (e: Element | null): boolean => { for (let n = e?.parentElement; n && n !== document.body; n = n.parentElement) if (/(auto|scroll)/.test(getComputedStyle(n).overflowX)) return true; return false; };
  return [...document.querySelectorAll("main *")].every((e) => { const r = e.getBoundingClientRect(); return r.width === 0 || r.right <= window.innerWidth + 1 || scrolls(e); });
});
/** Centre the control first: the fixed bottom tab bar can sit over a control Playwright scrolled just into view. */
const tap = async (l: Locator) => { await l.evaluate((e) => e.scrollIntoView({ block: "center" })); await l.click(); };
/** The app handles the click event; at phone width Playwright's hit-test retry scrolling keeps landing controls under the fixed tab bar, so this sends the event directly (no file chooser is involved after this point). */
const press = (l: Locator) => l.dispatchEvent("click");
const shot = async (page: Page, name: string) => { if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/${name}.png`, fullPage: true }); };

test("phone: scan a two-page bill with the camera, then review it", async ({ page, request }) => {
  const s = await seed(request);
  await request.post(`${API}/suppliers`, { headers: s.auth, data: { name: "Bestway Wholesale" } });
  await request.post(`${API}/inventory/items`, { headers: s.auth, data: { name: "Basmati Rice", base_unit: "g", reorder_level: "0" } });
  await openAs(page, s.token, "/manage", s.refresh);

  // One tap from Manage on a phone: the Overview's "Scan an invoice" card (the original layout).
  await tap(page.getByRole("button", { name: "Scan invoice", exact: true }));
  await expect(page).toHaveURL(/tab=suppliers&view=invoices/);
  const scan = page.getByRole("button", { name: "Scan with camera" });
  await expect(scan).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose file" })).toBeVisible();
  expect((await scan.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await noSideScroll(page)).toBe(true);
  await shot(page, "1-upload");

  // Page 1 and page 2 from the camera (the input the button opens), plus a page we then remove again.
  const cam = page.getByLabel("Camera photo");
  await cam.setInputFiles({ name: "IMG_0001.png", mimeType: "image/png", buffer: makePng([200, 40, 40]) });
  await expect(page.getByRole("img", { name: "Page 1" })).toBeVisible();
  await cam.setInputFiles({ name: "IMG_0002.png", mimeType: "image/png", buffer: makePng([40, 40, 200]) });
  await expect(page.getByRole("img", { name: "Page 2" })).toBeVisible();
  await cam.setInputFiles({ name: "IMG_0003.png", mimeType: "image/png", buffer: makePng([40, 200, 40]) });
  await expect(page.getByRole("img", { name: "Page 3" })).toBeVisible();
  // Page 3 sits in the second grid row: Playwright's own scroll-and-retry keeps landing it under the fixed tab bar or the image above, although
  // a centred hit-test lands on the button itself. The click event is what the app handles, so dispatch it.
  await page.getByRole("button", { name: "Remove page 3" }).dispatchEvent("click");
  await expect(page.getByRole("img", { name: "Page 3" })).toHaveCount(0);

  // Retake page 1: the camera opens again and the new photo replaces it.
  const chooser = page.waitForEvent("filechooser");
  await tap(page.getByRole("button", { name: "Retake page 1" }));
  await (await chooser).setFiles({ name: "IMG_0004.png", mimeType: "image/png", buffer: makePng([200, 200, 40]) });
  await expect(page.getByRole("img", { name: /^Page \d$/ })).toHaveCount(2);
  await expect(page.getByRole("heading", { name: /Bill photos/ })).toContainText("2 pages");
  expect(await noSideScroll(page)).toBe(true);
  await shot(page, "2-pages");

  // Both pages go up together as ONE purchase. OCR is off in e2e, so it lands as "failed" and the lines are typed.
  const sent = page.waitForRequest((r) => r.url().endsWith("/purchases/pages") && r.method() === "POST");
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)); // the bottom padding clears the fixed tab bar
  await page.getByRole("button", { name: "Read invoice" }).click();
  expect((await sent).headers()["content-type"]).toContain("multipart/form-data"); // (Playwright cannot read multipart blob bodies)
  await expect(page.getByText("We could not read this invoice")).toBeVisible({ timeout: 30_000 });
  const list = await (await request.get(`${API}/purchases`, { headers: s.auth })).json();
  expect(list).toHaveLength(1);

  // The review screen works at phone width.
  await page.getByLabel("Supplier", { exact: true }).selectOption({ label: "Bestway Wholesale" });
  await press(page.getByRole("button", { name: "Add line", exact: true }));
  await page.getByLabel("Description, line 1").fill("Basmati rice 20kg");
  await expect(page.getByRole("button", { name: "Confirm & add to stock" })).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
  const small = await page.locator("main").evaluate((root) => [...root.querySelectorAll("button, select, input:not([type=checkbox]):not([type=file]), a")]
    .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 44 && !e.closest("[aria-hidden=true], [role=radiogroup]"); }) // section pills are shared nav
    .map((e) => `${e.tagName} ${(e.getAttribute("aria-label") ?? e.textContent ?? "").trim().slice(0, 40)} ${Math.round(e.getBoundingClientRect().height)}px`));
  expect(small, "touch targets under 44px").toEqual([]);
  await shot(page, "3-review");

  // Map the line (the app suggests the matching item), price it and confirm: stock is updated.
  await press(page.getByRole("button", { name: "Use Basmati Rice?" }));
  await page.getByLabel("Unit, line 1").selectOption("kg");
  await page.getByLabel("Quantity, line 1").fill("20");
  await page.getByLabel("Unit price, line 1").fill("1.25");
  await press(page.getByRole("button", { name: "Confirm & add to stock" }));
  await press(page.getByRole("dialog").getByRole("button", { name: "Confirm & add to stock" }));
  await expect(page.getByRole("heading", { name: "Stock updated" })).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
  await shot(page, "5-done");
});

test("phone: scanning is off while offline", async ({ page, request, context }) => {
  const s = await seed(request);
  await openAs(page, s.token, "/manage?tab=suppliers&view=invoices", s.refresh);
  const scan = page.getByRole("button", { name: "Scan with camera" });
  await expect(scan).toBeEnabled();
  await context.setOffline(true);
  await expect(page.getByText("You are offline")).toBeVisible();
  await expect(scan).toBeDisabled();
  await expect(page.getByRole("button", { name: "Choose file" })).toBeDisabled();
  await shot(page, "4-offline");
  await context.setOffline(false);
  await expect(scan).toBeEnabled();
});

test("phone: a big sideways camera photo is shrunk upright in the browser before upload", async ({ page, request }) => {
  const s = await seed(request);
  await openAs(page, s.token, "/manage?tab=suppliers&view=invoices", s.refresh);
  // 4000x3000 sensor image with EXIF orientation 6 (phone held upright): must arrive as a 1500x2000 portrait page.
  await page.getByLabel("Camera photo").setInputFiles(path.join(__dirname, "fixtures", "phone-photo-4000x3000-exif6.jpg"));
  const thumb = page.getByRole("img", { name: "Page 1" });
  await expect(thumb).toBeVisible();
  await expect.poll(() => thumb.evaluate((i: HTMLImageElement) => [i.naturalWidth, i.naturalHeight])).toEqual([1500, 2000]);
});
