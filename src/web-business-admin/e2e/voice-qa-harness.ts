import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { API, seedIn, type Seed } from "./helpers";

/**
 * QA harness for voice ordering (docs/VOICE_QA_REPORT.md): a scripted SpeechRecognition that replays realistic recogniser
 * traces (word-by-word interims, finals, duplicate result events, a final split in two results, session ends with restarts,
 * no-speech / network errors, results arriving after stop / abort), and the owner's restaurant as a seed.
 * Unlike helpers.fakeSpeech, every recogniser instance keeps its own result list (a restart starts empty, like Chrome) and
 * the trace can still talk to an OLD instance (late results).
 */
export const installHarness = (page: Page, opts: { handsFree?: boolean; silenceMs?: number; busyAfterCloseMs?: number } = {}) => page.addInitScript(([handsFree, silenceMs, busyMs]) => {
  // the voice status chips are hidden from staff (owner 2026-11-13); the voice specs read them, so show them here
  try { localStorage.setItem("chilli.showVoiceChips", "1"); } catch { /* ignore */ }
  const w = window as unknown as Record<string, unknown>;
  // undefined: leave the hands-free switch as this browser has it (the soak flips it between sessions)
  try { if (handsFree === true) localStorage.removeItem("pos.wakeOff"); else if (handsFree === false) localStorage.setItem("pos.wakeOff", "1"); } catch { /* ignore */ }
  if (silenceMs) w.__POS_VOICE_SILENCE_MS = silenceMs;
  try {
    if (localStorage.getItem("pos.micDebug") === null) localStorage.setItem("pos.micDebug", "0"); // the mic debug box: off unless a spec turns it on
    if (localStorage.getItem("pos.voiceDirect") === null) localStorage.setItem("pos.voiceDirect", "0"); // Direct mode: off unless a spec turns it on
  } catch { /* ignore */ }
  type R = { t: string; final: boolean; alts?: string[] };
  class QaSR {
    lang = ""; continuous = false; interimResults = false; maxAlternatives = 1;
    onresult: ((e: unknown) => void) | null = null; onend: (() => void) | null = null; onerror: ((e: unknown) => void) | null = null;
    onstart: (() => void) | null = null; onaudiostart: (() => void) | null = null; onspeechstart: (() => void) | null = null;
    results: R[] = []; started = false; aborted = false; stopped = false; last: unknown = null;
    constructor() { made.push(this); }
    start() {
      // Chrome-like (busyAfterCloseMs): a recogniser started right after another one was stopped / aborted throws InvalidStateError
      if (busyMs && performance.now() - lastClosed < busyMs) throw new DOMException("recognition has already started", "InvalidStateError");
      if (inject.throws > 0) { inject.throws--; throw new DOMException("injected", "InvalidStateError"); }
      this.started = true;
      if (inject.errorOnStart) { const code = inject.errorOnStart; inject.errorOnStartLeft--; if (inject.errorOnStartLeft <= 0) inject.errorOnStart = ""; setTimeout(() => { this.started = false; this.onerror?.({ error: code }); this.onend?.(); }, 0); return; }
      if (inject.noStart > 0) { inject.noStart--; return; } // started, but never reports it (the watchdog must notice)
      if (w.__qaNoStartFirst) { w.__qaNoStartFirst = false; return; } // the page's FIRST recogniser never reports (a start that silently fails)
      setTimeout(() => { if (this.started) { this.onstart?.(); this.onaudiostart?.(); } }, 0);
    }
    // only a recogniser that was running is "still closing" afterwards (aborting one whose start threw changes nothing)
    stop() { if (this.started) lastClosed = performance.now(); this.started = false; this.stopped = true; setTimeout(() => this.onend?.(), 0); }
    abort() { if (this.started) lastClosed = performance.now(); this.started = false; this.aborted = true; }
    emit() {
      const list = this.results.map((r) => Object.assign([{ transcript: r.t }, ...(r.alts ?? []).map((a) => ({ transcript: a }))], { isFinal: r.final }));
      const ev = { resultIndex: 0, results: Object.assign(list, { length: list.length }) };
      this.last = ev;
      this.onresult?.(ev);
    }
  }
  const made: QaSR[] = [];
  let lastClosed = -1e9;
  const inject = { throws: 0, errorOnStart: "", errorOnStartLeft: 0, noStart: 0 };
  const cur = () => made[made.length - 1];
  w.SpeechRecognition = QaSR; w.webkitSpeechRecognition = QaSR;
  w.__qa = {
    count: () => made.length,
    listening: () => made.filter((r) => r.started).length,
    /** An interim guess of the current phrase (replaces the previous interim). */
    interim: (t: string) => { const r = cur(); const i = r.results.findIndex((x) => !x.final); if (i >= 0) r.results[i] = { t, final: false }; else r.results.push({ t, final: false }); r.emit(); },
    /** The current phrase finalised. */
    final: (t: string) => { const r = cur(); r.results = r.results.filter((x) => x.final); r.results.push({ t, final: true }); r.emit(); },
    /** The same result event delivered again. */
    dup: () => { const r = cur(); if (r.last) r.onresult?.(r.last); },
    /** Chrome ends the session after a pause (the app restarts it); `withInterim` keeps an unfinished interim (it never became final). */
    end: () => { const r = cur(); r.started = false; r.onend?.(); },
    error: (code: string) => { const r = cur(); r.onerror?.({ error: code }); r.started = false; r.onend?.(); },
    /** A result for an OLD recogniser (index from the end: 1 = the one before the newest) arriving late. */
    late: (back: number, t: string) => { const r = made[made.length - 1 - back]; if (!r) return; r.results.push({ t, final: true }); r.emit(); },
    /** Failure injection (docs/VOICE_QA_REPORT.md round 2). */
    kill: () => { const r = cur(); r.started = false; },
    /** A final with the recogniser's other guesses (maxAlternatives): the first is what it shows, the others are alternatives. */
    finalAlts: (ts: string[]) => { const r = cur(); r.results = r.results.filter((x) => x.final); r.results.push({ t: ts[0], final: true, alts: ts.slice(1) }); r.emit(); },
    /** The microphone hears speech (onspeechstart) but no result follows: a deaf recogniser. */
    speechStart: () => { cur().onspeechstart?.(); }, // dies without onend / onerror (sleep, lid, device switch)
    throwNext: (n: number) => { inject.throws = n; },
    errorOnStart: (code: string, n: number) => { inject.errorOnStart = code; inject.errorOnStartLeft = n; },
    noStartNext: (n: number) => { inject.noStart = n; },
    deviceChange: () => { navigator.mediaDevices?.dispatchEvent?.(new Event("devicechange")); },
    hide: (hidden: boolean) => { Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden }); Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") }); document.dispatchEvent(new Event("visibilitychange")); },
    newest: () => made.length - 1,
    newestListening: () => { const r = cur(); return !!r && r.started; },
  };
}, [opts.handsFree ?? null, opts.silenceMs ?? 0, opts.busyAfterCloseMs ?? 0] as const);

type Qa = { count: () => number; listening: () => number; interim: (t: string) => void; final: (t: string) => void; dup: () => void; end: () => void; error: (c: string) => void; late: (b: number, t: string) => void;
  kill: () => void; finalAlts: (ts: string[]) => void; speechStart: () => void; throwNext: (n: number) => void; errorOnStart: (c: string, n: number) => void; noStartNext: (n: number) => void; deviceChange: () => void; hide: (h: boolean) => void; newest: () => number; newestListening: () => boolean };
export const qa = <K extends keyof Qa>(page: Page, k: K, ...args: Parameters<Qa[K]>) =>
  page.evaluate(([k, a]) => ((window as unknown as { __qa: Record<string, (...x: unknown[]) => unknown> }).__qa[k as string](...(a as unknown[]))), [k, args] as const) as Promise<ReturnType<Qa[K]>>;

export interface OwnerMenu extends Seed { ids: Record<string, string>; variants: Record<string, string> }

/**
 * The owner's restaurant: Matar Paneer, Sweet Lassi, Mango Lassi, Tandoori Roti (aliases lassi -> Sweet Lassi, chapati ->
 * Tandoori Roti), and for the soak: Butter Chicken (Half / Full), Dal Makhani, Garlic Naan, two biryanis (an ambiguous
 * "biryani") and Jeera Rice (sold out today). Prices include GST.
 */
export async function seedOwner(request: APIRequestContext): Promise<OwnerMenu> {
  const s = await seedIn(request);
  const h = { headers: s.auth };
  const put = await request.put(`${API}/restaurant`, { ...h, data: { name: "Chilli Test Dhaba", trn: "27AAPFU0939F1ZV", address: null, prices_include_tax: true } });
  expect(put.status(), await put.text()).toBe(200);
  const cat = async (name: string) => (await (await request.post(`${API}/menu/categories`, { ...h, data: { name } })).json()).id as string;
  const mains = await cat("Curries"), drinks = await cat("Drinks"), breads = await cat("Breads"), rice = await cat("Rice");
  const ids: Record<string, string> = {}, variants: Record<string, string> = {};
  const item = async (category_id: string, name: string, price: string, v: { name: string; price_delta: string }[] = []) => {
    const r = await request.post(`${API}/menu/items`, { ...h, data: { category_id, name, price, variants: v } });
    expect(r.status(), await r.text()).toBe(201);
    const j = await r.json() as { id: string; variants: { id: string; name: string }[] };
    ids[name] = j.id;
    for (const x of j.variants ?? []) variants[`${name}/${x.name}`] = x.id;
  };
  await item(mains, "Matar Paneer", "240.00");
  await item(drinks, "Sweet Lassi", "80.00");
  await item(drinks, "Mango Lassi", "90.00");
  await item(breads, "Tandoori Roti", "20.00");
  await item(mains, "Butter Chicken", "280.00", [{ name: "Half", price_delta: "0.00" }, { name: "Full", price_delta: "180.00" }]);
  await item(mains, "Dal Makhani", "220.00");
  await item(breads, "Garlic Naan", "60.00");
  await item(rice, "Chicken Biryani", "260.00");
  await item(rice, "Mutton Biryani", "320.00");
  await item(rice, "Jeera Rice", "150.00");
  for (const [phrase, name] of [["lassi", "Sweet Lassi"], ["chapati", "Tandoori Roti"]]) {
    const r = await request.put(`${API}/menu/voice-aliases`, { ...h, data: { phrase, menu_item_id: ids[name], variant_id: null } });
    expect(r.status(), await r.text()).toBeLessThan(300);
  }
  const so = await request.patch(`${API}/menu/items/${ids["Jeera Rice"]}/sold-out`, { ...h, data: { sold_out: true } });
  expect(so.status(), await so.text()).toBeLessThan(300);
  return { ...s, ids, variants };
}

export interface CartLineView { name: string; qty: number; check: boolean; variantId: string | null }
export interface TicketView { no: number; placed: boolean; kot: unknown; lines: CartLineView[]; more: CartLineView[] }

/** Every open ticket as the till saved it (IndexedDB "pos-offline" / "drafts"; written a moment after each change). */
export const tickets = (page: Page) => page.evaluate(() => new Promise<TicketView[]>((res) => {
  const r = indexedDB.open("pos-offline");
  r.onerror = () => res([]);
  r.onsuccess = () => {
    const db = r.result;
    if (!db.objectStoreNames.contains("drafts")) { db.close(); res([]); return; }
    const q = db.transaction("drafts").objectStore("drafts").getAll();
    q.onsuccess = () => {
      type L = { item: { name: string }; qty: number; check?: boolean; variantId: string | null };
      const v = (l: L) => ({ name: l.item.name, qty: l.qty, check: !!l.check, variantId: l.variantId });
      res((q.result as { data: { no: number; order: unknown; kot: unknown; lines: L[]; more?: L[] } }[]).map((d) => ({
        no: d.data.no, placed: !!d.data.order, kot: d.data.kot, lines: d.data.lines.map(v), more: (d.data.more ?? []).map(v) })));
      db.close();
    };
    q.onerror = () => { db.close(); res([]); };
  };
}));

/** Forget every ticket of this browser (a clean counter for the next session). */
export const wipeTickets = (page: Page) => page.evaluate(() => new Promise<void>((res) => {
  const r = indexedDB.open("pos-offline");
  r.onerror = () => res();
  r.onsuccess = () => {
    const db = r.result;
    if (!db.objectStoreNames.contains("drafts")) { db.close(); res(); return; }
    const tx = db.transaction("drafts", "readwrite");
    tx.objectStore("drafts").clear();
    tx.oncomplete = () => { db.close(); res(); };
    tx.onerror = () => { db.close(); res(); };
  };
}));

/**
 * The harness's own API session (its own login, so the browser's refresh token is never rotated under it): the access token
 * lives ~15 minutes, a soak runs longer, so a 401 signs in again.
 */
export function apiSession(request: APIRequestContext, s: Seed) {
  let auth = s.auth;
  const login = async () => {
    const r = await request.post(`${API}/auth/login`, { data: { email: s.email, password: "supersecret123" } });
    expect(r.status(), await r.text()).toBe(200);
    auth = { Authorization: `Bearer ${(await r.json()).access_token as string}` };
  };
  const get = async <T,>(path: string): Promise<T> => {
    for (let k = 0; k < 2; k++) {
      const r = await request.get(`${API}${path}`, { headers: auth });
      if (r.status() === 401 && k === 0) { await login(); continue; }
      expect(r.status(), `${path}: ${await r.text()}`).toBe(200);
      return (await r.json()) as T;
    }
    throw new Error("unreachable");
  };
  return { login, get };
}

export type ServerOrder = { id: string; status: string; order_type: string; lines: { item_name: string; quantity: number; variant_id?: string | null }[] };
export const serverOrders = async (request: APIRequestContext, s: Seed) => (await (await request.get(`${API}/orders`, { headers: s.auth })).json()) as ServerOrder[];
export const serverKots = async (request: APIRequestContext, s: Seed) => (await (await request.get(`${API}/kot`, { headers: s.auth })).json()) as { order_id: string }[];
