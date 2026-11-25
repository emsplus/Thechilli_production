import { test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { API, expect, log, openAs, resetAbuse, seedMenu, shot, sleep, type Seed } from "./common";

/**
 * Scenario 2: 2 waiter devices (two different waiters, PWA :13931) + 1 counter (business app /orders) + 1 kitchen screen (/kitchen)
 * against one restaurant for CHAOS_MINUTES (default 10) of scripted, randomised traffic: placing, adding to an order from another
 * device, counter add / KOT / bill / pay / table move racing the waiters, shift closed on one device. Every ~90 s the traffic pauses
 * and every screen must converge to the server within the poll interval; item quantities are checked against a ledger of the
 * actions that reported success (no phantom, no lost items).
 */
const MINUTES = Number(process.env.CHAOS_MINUTES ?? 10);
const WAITER = process.env.E2E_PWA_URL ?? "http://localhost:13931";
const COUNTER = `http://localhost:${process.env.E2E_WEB_PORT ?? "13933"}`;
const PW = "Masala-Dosa-2026-x";
const POLL_SLACK_MS = 22_000; // waiter orders / tables poll 10 s, counter orders 10 s, kitchen ?

type Json = any;
const j = async (r: any) => { try { return await r.json(); } catch { return null; } };

test(`M1 multi-device ${MINUTES} min: 2 waiters + counter + kitchen converge, no phantom / lost items`, async ({ browser, request }) => {
  test.setTimeout((MINUTES + 15) * 60_000);
  resetAbuse();
  const s = await seedMenu(request);
  const owner = s.auth;
  const me = await j(await request.get(`${API}/auth/me`, { headers: owner }));
  const code: string = me.restaurant_code;
  const tables: Record<string, string> = { T1: s.tableId };
  for (let i = 2; i <= 10; i++) tables[`T${i}`] = (await j(await request.post(`${API}/tables`, { headers: owner, data: { label: `T${i}` } }))).id;
  const tableLabel = Object.fromEntries(Object.entries(tables).map(([k, v]) => [v, k]));
  const dish = (n: string) => s.items[n].id;
  const dishNames = ["Lamb Karahi", "Cucumber Salad", "Coke", "Garlic Naan"];
  const mkWaiter = async (name: string) => {
    const phone = `+9198${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;
    const r = await request.post(`${API}/auth/users`, { headers: owner, data: { phone, full_name: name, password: PW, role: "waiter" } });
    expect(r.status()).toBe(201);
    const l = await j(await request.post(`${API}/auth/login`, { data: { identifier: phone, password: PW, restaurant_code: code } }));
    return { phone, token: l.access_token as string };
  };
  const wA = await mkWaiter("Asha"), wB = await mkWaiter("Bhim");

  // ---------- devices
  const waiterLogin = async (page: Page, w: { phone: string }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/(welcome|login)\/?$/, { timeout: 30_000 });
    if (/welcome/.test(page.url())) await page.locator("a,button").filter({ hasText: /^sign in$/i }).first().click();
    await page.getByLabel(/phone or email/i).fill(w.phone);
    await page.getByLabel("Password", { exact: true }).fill(PW);
    await page.getByLabel("Restaurant code").fill(code);
    await page.locator("button.primary").click();
    if (await page.getByRole("button", { name: /skip for now/i }).isVisible({ timeout: 3000 }).catch(() => false)) await page.getByRole("button", { name: /skip for now/i }).click();
    await expect(page).toHaveURL(/\/outlet\/?$/, { timeout: 20_000 });
    await page.getByRole("button", { name: /Start shift/i }).first().click();
    await expect(page).toHaveURL(/\/tables\/?$/, { timeout: 20_000 });
  };
  const mkWaiterDevice = async (w: { phone: string }) => {
    const ctx = await browser.newContext({ baseURL: WAITER, serviceWorkers: "block", viewport: { width: 412, height: 842 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => log("M1-pageerrors.log", `waiter pageerror: ${e.message}`));
    await waiterLogin(page, w);
    return { ctx, page };
  };
  const W1 = await mkWaiterDevice(wA), W2 = await mkWaiterDevice(wB);
  const cctx = await browser.newContext({ baseURL: COUNTER, serviceWorkers: "block", viewport: { width: 1280, height: 800 } });
  const counter = await cctx.newPage();
  counter.on("pageerror", (e) => log("M1-pageerrors.log", `counter pageerror: ${e.message}`));
  await openAs(counter, s.token, "/orders", s.refresh);
  const kctx = await browser.newContext({ baseURL: COUNTER, serviceWorkers: "block", viewport: { width: 1280, height: 800 } });
  const kitchen = await kctx.newPage();
  kitchen.on("pageerror", (e) => log("M1-pageerrors.log", `kitchen pageerror: ${e.message}`));
  await openAs(kitchen, s.token, "/kitchen", s.refresh);

  // ---------- server helpers + ledger
  const ledger = new Map<string, Map<string, number>>(); // order id -> item id -> qty expected (only actions that reported success)
  const addLedger = (oid: string, item: string, q: number) => { const m = ledger.get(oid) ?? new Map(); m.set(item, (m.get(item) ?? 0) + q); ledger.set(oid, m); };
  const orders = async (): Promise<Json[]> => await j(await request.get(`${API}/orders`, { headers: owner }));
  const openOrders = async () => (await orders()).filter((o) => ["open", "sent_to_kitchen"].includes(o.status));
  const rnd = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
  const stats: Record<string, number> = {};
  const bump = (k: string) => { stats[k] = (stats[k] ?? 0) + 1; };

  // waiter UI actions
  const tab = (p: Page, n: RegExp) => p.getByRole("navigation", { name: "Main" }).getByRole("link", { name: n });
  const addOnMenu = async (p: Page, dishes: string[]) => {
    await tab(p, /^Menu/).click();
    const seen = new Set<string>();
    for (const d of dishes) { await p.getByRole("button", { name: seen.has(d) ? `Add one more ${d}` : `Add ${d}`, exact: true }).click(); seen.add(d); }
  };
  const waiterPlace = async (p: Page, table: string, dishes: string[]) => {
    await addOnMenu(p, dishes);
    await tab(p, /^Cart/).click();
    await p.getByRole("link", { name: /Pick table|Change/ }).click();
    await p.locator("button.tile").filter({ has: p.locator(".tile-label", { hasText: new RegExp(`^${table}$`) }) }).click();
    await expect(p).toHaveURL(/\/cart\/?$/);
    await p.getByRole("button", { name: /Send to kitchen/ }).click();
    await expect(p).toHaveURL(/\/orders\/?$/);
  };
  const waiterAddToOrder = async (p: Page, table: string, dishes: string[]) => {
    await tab(p, /^Orders/).click();
    await p.locator("a", { hasText: new RegExp(`Table ${table}\\b`) }).first().click({ timeout: 12_000 });
    await p.getByRole("button", { name: /^Add items$/ }).click({ timeout: 12_000 });
    await addOnMenu(p, dishes);
    await tab(p, /^Cart/).click();
    await p.getByRole("button", { name: /Send to kitchen/ }).click();
    await expect(p).toHaveURL(/\/orders\/?$/, { timeout: 12_000 });
  };

  const rounds: string[] = [];
  const end = Date.now() + MINUTES * 60_000;
  let nextCheck = Date.now() + 90_000, checkNo = 0, shiftClosed = false, failures = 0;

  const converge = async (label: string) => {
    checkNo++;
    await sleep(POLL_SLACK_MS);
    const srv = await orders();
    const open = srv.filter((o) => ["open", "sent_to_kitchen"].includes(o.status));
    const openTables = new Set(open.map((o) => tableLabel[o.table_id]));
    const kots = srv.flatMap((o) => (o.kots ?? []).map((k: Json) => k.number as number));
    const res: string[] = [];
    // waiter Orders list
    for (const [name, w] of [["W1", W1], ["W2", W2]] as const) {
      await w.page.goto("/orders"); await sleep(1500);
      const seen = new Set<string>();
      for (const t of Object.keys(tables)) if (await w.page.locator("a", { hasText: new RegExp(`Table ${t}\\b`) }).count()) seen.add(t);
      const missing = [...openTables].filter((t) => !seen.has(t)), phantom = [...seen].filter((t) => !openTables.has(t));
      if (missing.length || phantom.length) res.push(`${name} orders list missing=${missing} phantom=${phantom}`);
    }
    // counter Orders page
    await counter.reload(); await sleep(2500);
    const ctext = await counter.locator("main").innerText();
    const cm = [...openTables].filter((t) => !new RegExp(`Table ${t}\\b`).test(ctext));
    if (cm.length) res.push(`counter /orders missing=${cm}`);
    // kitchen: a ticket per KOT number (all < 20 min old)
    await kitchen.reload(); await sleep(2500);
    const ktext = await kitchen.locator("main").innerText();
    const km = kots.filter((n) => !new RegExp(`#${n}\\b`).test(ktext));
    if (km.length) res.push(`kitchen missing KOT #${km}`);
    // ledger: no phantom, no lost items
    for (const o of srv) {
      if (o.status === "cancelled") continue;
      const want = ledger.get(o.id); if (!want) continue;
      const got = new Map<string, number>(); for (const l of o.lines) got.set(l.item_id, (got.get(l.item_id) ?? 0) + l.quantity);
      for (const [item, q] of want) if ((got.get(item) ?? 0) !== q) res.push(`order ${tableLabel[o.table_id]} item ${item.slice(0, 4)} want ${q} got ${got.get(item) ?? 0}`);
      for (const [item, q] of got) if (!want.has(item)) res.push(`order ${tableLabel[o.table_id]} phantom item ${item.slice(0, 4)} qty ${q}`);
    }
    log("M1.log", `CHECK ${checkNo} (${label}): open=${[...openTables]} kots=${kots.length} ${res.length ? "DIVERGED: " + res.join(" | ") : "converged"}`);
    if (res.length) { failures += res.length; await shot(W1.page, `M1-diverged-${checkNo}-W1`); await shot(counter, `M1-diverged-${checkNo}-counter`); }
    else if (checkNo === 1) { await shot(W1.page, "M1-converged-W1"); await shot(counter, "M1-converged-counter"); await shot(kitchen, "M1-converged-kitchen"); }
  };

  while (Date.now() < end) {
    const open = await openOrders();
    const free = Object.keys(tables).filter((t) => !open.some((o) => o.table_id === tables[t]));
    const action = rnd(["place", "place", "wadd", "cadd", "bill", "pay", "move", "race-kot", "race-bill-add", ...(process.env.CHAOS_TABLE_RACE ? ["table-race"] : [])]);
    try {
      if (action === "place" && free.length) {
        const t = rnd(free), w = rnd([W1, W2]), d = [rnd(dishNames), rnd(dishNames)];
        await waiterPlace(w.page, t, d);
        await expect.poll(async () => (await openOrders()).some((o) => o.table_id === tables[t]), { timeout: 20_000 }).toBe(true);
        const o = (await openOrders()).find((x) => x.table_id === tables[t])!;
        for (const n of d) addLedger(o.id, dish(n), 1);
        bump("place");
      } else if (action === "wadd" && open.length) {
        const o = rnd(open); const t = tableLabel[o.table_id]; const w = rnd([W1, W2]); const d = [rnd(dishNames)];
        await waiterAddToOrder(w.page, t, d);
        await expect.poll(async () => (await orders()).find((x) => x.id === o.id).lines.length, { timeout: 20_000 }).toBeGreaterThan(o.lines.length);
        addLedger(o.id, dish(d[0]), 1); bump("wadd");
      } else if (action === "cadd" && open.length) {
        const o = rnd(open); const n = rnd(dishNames);
        const r = await request.post(`${API}/orders/${o.id}/lines`, { headers: owner, data: { batch_uuid: crypto.randomUUID(), lines: [{ item_id: dish(n), quantity: 1 }] } });
        if (r.status() === 200) { addLedger(o.id, dish(n), 1); if (Math.random() < 0.7) await request.post(`${API}/orders/${o.id}/kot`, { headers: owner }); bump("cadd"); } else bump("cadd-refused-" + r.status());
      } else if (action === "bill" && open.length) {
        const o = rnd(open);
        const r = await request.post(`${API}/orders/${o.id}/bill`, { headers: owner, data: {} });
        bump("bill-" + r.status());
      } else if (action === "pay") {
        const bills: Json[] = await j(await request.get(`${API}/bills`, { headers: owner }));
        const b = bills.find((x) => x.status === "active" && Number(x.balance_due) > 0);
        if (b) { const r = await request.post(`${API}/bills/${b.id}/payments`, { headers: owner, data: { idempotency_key: crypto.randomUUID(), method: "cash", amount: b.balance_due } }); bump("pay-" + r.status()); }
      } else if (action === "move" && open.length && free.length) {
        const o = rnd(open); const t = rnd(free);
        const r = await request.post(`${API}/orders/${o.id}/transfer`, { headers: owner, data: { table_id: tables[t] } });
        bump("move-" + r.status());
      } else if (action === "race-kot" && open.length) {
        // KOT from the counter and an add+KOT from a waiter at the same moment
        const o = rnd(open); const t = tableLabel[o.table_id]; const w = rnd([W1, W2]); const d = [rnd(dishNames)];
        await Promise.all([request.post(`${API}/orders/${o.id}/kot`, { headers: owner }), waiterAddToOrder(w.page, t, d)]);
        await expect.poll(async () => (await orders()).find((x) => x.id === o.id).lines.length, { timeout: 20_000 }).toBeGreaterThan(o.lines.length);
        addLedger(o.id, dish(d[0]), 1); bump("race-kot");
      } else if (action === "race-bill-add" && open.length) {
        // counter bills while a waiter adds an item to the same order
        const o = rnd(open.filter((x) => x.kots?.length) .length ? open.filter((x) => x.kots?.length) : open); const t = tableLabel[o.table_id]; const w = rnd([W1, W2]); const d = [rnd(dishNames)];
        const [br] = await Promise.all([request.post(`${API}/orders/${o.id}/bill`, { headers: owner, data: {} }), waiterAddToOrder(w.page, t, d).catch(() => {})]);
        await sleep(4000);
        const now = (await orders()).find((x) => x.id === o.id);
        const bill: Json | undefined = (await j(await request.get(`${API}/bills`, { headers: owner })))?.find((x: Json) => x.order_id === o.id && x.status === "active");
        if (bill) { // every line of the order must be on the bill
          const orderTotal = now.lines.reduce((n: number, l: Json) => n + Number(l.unit_price) * l.quantity, 0);
          const billLines = bill.lines.reduce((n: number, l: Json) => n + l.quantity, 0), orderQty = now.lines.reduce((n: number, l: Json) => n + l.quantity, 0);
          if (billLines !== orderQty) { log("M1.log", `BILL/ORDER MISMATCH order ${t}: order qty ${orderQty} (${orderTotal}) vs bill qty ${billLines} (${bill.subtotal}) bill-status=${br.status()}`); failures++; }
        }
        // the ledger for this order is unreliable if the add raced the bill: resync it from the server
        ledger.delete(o.id); bump("race-bill-add");
      } else if (action === "table-race" && free.length) {
        // two waiters and the counter all create an order for the same free table at once
        const t = rnd(free);
        const mk = (token: string) => request.post(`${API}/orders`, { headers: { Authorization: `Bearer ${token}` }, data: { client_uuid: crypto.randomUUID(), order_type: "indoor", table_id: tables[t], lines: [{ item_id: dish("Coke"), quantity: 1 }] } });
        const rs = await Promise.all([mk(wA.token), mk(wB.token), mk(s.token)]);
        const ok = rs.filter((r) => r.status() === 201).length;
        const nOpen = (await openOrders()).filter((o) => o.table_id === tables[t]).length;
        bump(`table-race-${ok}created-${nOpen}open`);
        if (nOpen !== 1) { log("M1.log", `TABLE RACE: ${nOpen} open orders on ${t} (created ${ok})`); failures++; }
        const o = (await openOrders()).find((x) => x.table_id === tables[t]); if (o) ledger.delete(o.id);
      }
    } catch (e) {
      bump("action-error"); log("M1.log", `action ${action} error: ${String(e).split("\n")[0]}`); await shot(W1.page, `M1-error-${Date.now() % 100000}`);
      for (const w of [W1, W2]) await w.page.goto("/tables").catch(() => {});
    }
    // shift closed on one device, once, halfway
    if (!shiftClosed && Date.now() > end - (MINUTES * 60_000) / 2) {
      shiftClosed = true;
      const r = await request.post(`${API}/shifts/close`, { headers: { Authorization: `Bearer ${wB.token}` }, data: {} });
      log("M1.log", `shift close on waiter B via API -> ${r.status()}`);
      bump("shift-close");
    }
    if (Date.now() > nextCheck) { await converge("periodic"); nextCheck = Date.now() + 90_000; }
    await sleep(1500 + Math.random() * 2500);
  }
  await converge("final");
  log("M1.log", `stats ${JSON.stringify(stats)} divergences=${failures}`);
  expect(failures).toBe(0);
  await Promise.all([W1.ctx.close(), W2.ctx.close(), cctx.close(), kctx.close()]);
});
