import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { API, seedIn, type Seed } from "./helpers";

/** POST/PUT to the real API as the seeded owner; fails the test with the server's answer. */
export async function call<T = unknown>(request: APIRequestContext, s: Seed, method: "post" | "put" | "patch", path: string, data?: unknown): Promise<T> {
  const r = await request[method](`${API}${path}`, { headers: s.auth, data });
  expect(r.ok(), `${method.toUpperCase()} ${path}: ${r.status()} ${await r.text()}`).toBe(true);
  return r.json() as Promise<T>;
}

export interface Id { id: string }
export interface InvSeed extends Seed {
  paneer: string; milk: string; rice: string; supplierId: string; supplier2Id: string;
}

/**
 * An Indian restaurant with one dish ("Paneer Tikka", ₹250), three stock items (Paneer g, Milk ml, Basmati rice g), two suppliers,
 * opening stock through the adjustment API and a recipe for the dish. Everything goes through the real API.
 */
export async function seedInventory(request: APIRequestContext): Promise<InvSeed> {
  const s = await seedIn(request);
  const paneer = await call<Id>(request, s, "post", "/inventory/items", { name: "Paneer", base_unit: "g", reorder_level: "2000", reorder_quantity: "10000" });
  const milk = await call<Id>(request, s, "post", "/inventory/items", { name: "Milk", base_unit: "ml", reorder_level: "5000", reorder_quantity: "20000" });
  const rice = await call<Id>(request, s, "post", "/inventory/items", { name: "Basmati rice", base_unit: "g", reorder_level: "3000", reorder_quantity: "25000" });
  const supplier = await call<Id>(request, s, "post", "/suppliers", { name: "Sharma Dairy", phone: "+919876543210", email: "orders@sharma-dairy.example.in" });
  const supplier2 = await call<Id>(request, s, "post", "/suppliers", { name: "Gupta Traders", phone: "+919811122233" });
  await call(request, s, "post", "/inventory/adjustments", { idempotency_key: randomUUID(), item_id: paneer.id, kind: "adjustment", quantity: "12", unit: "kg", reason: "opening stock" });
  await call(request, s, "post", "/inventory/adjustments", { idempotency_key: randomUUID(), item_id: milk.id, kind: "adjustment", quantity: "30", unit: "l", reason: "opening stock" });
  await call(request, s, "post", "/inventory/adjustments", { idempotency_key: randomUUID(), item_id: rice.id, kind: "adjustment", quantity: "2", unit: "kg", reason: "opening stock" });
  await call(request, s, "post", "/recipes", { menu_item_id: s.itemId, ingredients: [{ item_id: paneer.id, quantity: "150", unit: "g" }, { item_id: milk.id, quantity: "50", unit: "ml" }] });
  return { ...s, paneer: paneer.id, milk: milk.id, rice: rice.id, supplierId: supplier.id, supplier2Id: supplier2.id };
}

/** Sets the colour scheme the way the app stores it, before the first paint. */
export async function setTheme(page: Page, theme: "light" | "dark") {
  await page.addInitScript((t) => { try { localStorage.setItem("pos.theme", t); } catch { /* ignore */ } }, theme);
}

/** No horizontal page scroll: the document is not wider than the viewport. */
export async function noHScroll(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/** Interactive controls under 44 px (CSS pixels) that are visible: name + size, for the audit. */
export async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("button, a[href], input:not([type=hidden]), select, textarea, [role=tab], [role=switch], [role=checkbox]"))) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0") continue;
      if (el.closest("[aria-hidden=true], .ch-sr-only")) continue;
      if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio") && el.closest("label")) continue;
      if (el instanceof HTMLInputElement && el.type === "file") continue;
      if (r.width <= 2 && r.height <= 2) continue; // visually hidden (skip link, file inputs)
      if (r.height < 43.5 || r.width < 43.5) out.push(`${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") || el.textContent || el.getAttribute("placeholder") || "").trim().slice(0, 40)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return out;
  });
}

export interface Activity { poId: string; grnId: string; grnLineId: string; batchItem: string }

/**
 * Stock activity through the API so every list has rows: a sent PO of 20 kg paneer received PARTLY (8 kg, with the supplier's bill number),
 * a return of 1 kg, wastage, a posted count, an expiring batch of a batch-tracked item (curd), one sale (paneer and milk leave stock).
 */
export async function seedActivity(request: APIRequestContext, s: InvSeed): Promise<Activity> {
  const po = await call<{ id: string; lines: { id: string }[] }>(request, s, "post", "/purchase-orders", {
    supplier_id: s.supplierId, expected_date: null, notes: "Weekly dairy",
    lines: [{ item_id: s.paneer, quantity: "20", unit: "kg", unit_price: "320", tax_rate: "5" }, { item_id: s.milk, quantity: "40", unit: "l", unit_price: "58", tax_rate: "0" }] });
  await call(request, s, "post", `/purchase-orders/${po.id}/send`);
  const grn = await call<{ id: string; lines: { id: string }[] }>(request, s, "post", `/purchase-orders/${po.id}/receipts`, {
    idempotency_key: randomUUID(), supplier_invoice_no: "SD-7781", lines: [{ po_line_id: po.lines[0].id, quantity: "8", rejected_quantity: "0" }] });
  await call(request, s, "post", "/purchase-returns", { idempotency_key: randomUUID(), grn_id: grn.id, reason: "Sour smell on two blocks", lines: [{ grn_line_id: grn.lines[0].id, quantity: "1", unit: "kg" }] });
  await call(request, s, "post", "/inventory/wastage", { idempotency_key: randomUUID(), item_id: s.milk, quantity: "2", unit: "l", reason_code: "spoilage", note: "Fridge was off" });
  const curd = await call<Id>(request, s, "post", "/inventory/items", { name: "Curd", base_unit: "g", reorder_level: "1000", reorder_quantity: "5000", tracks_batches: true });
  const po2 = await call<{ id: string; lines: { id: string }[] }>(request, s, "post", "/purchase-orders", {
    supplier_id: s.supplierId, expected_date: null, notes: null, lines: [{ item_id: curd.id, quantity: "5", unit: "kg", unit_price: "90", tax_rate: "0" }] });
  await call(request, s, "post", `/purchase-orders/${po2.id}/send`);
  const soon = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
  await call(request, s, "post", `/purchase-orders/${po2.id}/receipts`, { idempotency_key: randomUUID(), lines: [{ po_line_id: po2.lines[0].id, quantity: "5", rejected_quantity: "0", batch_no: "CD-1", expiry_date: soon }] });
  const cnt = await call<{ id: string }>(request, s, "post", "/stock/counts", { name: "Weekly count" });
  await call(request, s, "put", `/stock/counts/${cnt.id}/lines`, { lines: [{ item_id: s.rice, counted: "1.5", unit: "kg" }] });
  await call(request, s, "post", `/stock/counts/${cnt.id}/post`);
  const o = await call<{ id: string }>(request, s, "post", "/orders", { client_uuid: randomUUID(), order_type: "takeaway", table_id: null, lines: [{ item_id: s.itemId, quantity: 2 }] });
  await call(request, s, "post", `/orders/${o.id}/bill`, {});
  return { poId: po.id, grnId: grn.id, grnLineId: grn.lines[0].id, batchItem: curd.id };
}

/** Elements that stick out of the viewport on the right (or left), outermost first: the cause of a clipped layout that the page scrollWidth hides. */
export async function overflowing(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out: { d: string; r: number }[] = [];
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const cs = getComputedStyle(el);
      if (cs.position === "fixed" || el.closest("[aria-hidden=true], .sr-only, .ch-sr-only")) continue;
      // inside a deliberate scroller (overflow-x auto / scroll) is fine
      let p: HTMLElement | null = el.parentElement, scroller = false;
      while (p && p !== document.body) { const o = getComputedStyle(p).overflowX; if (o === "auto" || o === "scroll") { scroller = true; break; } p = p.parentElement; }
      if (scroller) continue;
      if (r.right > vw + 1 || r.left < -1) out.push({ d: `${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.split(" ").slice(0, 3).join(".") : ""} [${Math.round(r.left)}..${Math.round(r.right)}] "${(el.textContent ?? "").trim().slice(0, 30)}"`, r: r.right });
    }
    return out.sort((a, b) => b.r - a.r).slice(0, 8).map((x) => x.d);
  });
}

/** A valid solid-colour PNG, built in memory (no fixture files). */
export function makePng(rgb: [number, number, number]): Buffer {
  const w = 64, h = 48;
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

