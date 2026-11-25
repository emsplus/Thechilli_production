import { expect, test, type Page } from "@playwright/test";
import { openAs } from "./helpers";
import { apiSession, installHarness, qa, seedOwner, tickets, wipeTickets, type OwnerMenu, type ServerOrder, type TicketView } from "./voice-qa-harness";

/**
 * Randomised voice soak (docs/VOICE_QA_REPORT.md). Every session: 1-5 dishes with quantities and sizes, sometimes a soft-flag
 * dish ("to garlic naan"), an ambiguous dish ("biryani": a default is picked, never a block) or a sold-out one ("jeera rice"),
 * one random ending (done / add to order: add only; place order / send to kitchen: add + place + kitchen ticket after the
 * countdown; misheard variants included; sometimes "done" first and "place order" as a second step; sometimes "stop" during the
 * countdown; or nothing), replayed as a realistic recogniser trace with random timing, hands-free on or off, the wake word first
 * or a tap. Invariants (owner rules 2026-11): addable dishes end up in the cart exactly once; with place / send the order is
 * placed exactly once and its kitchen ticket sent exactly once; nothing is placed or sent without a place / send phrase or after
 * "stop"; the sheet ends where it should; no console errors.
 *   SOAK_N (default 300), SOAK_SEED (default 1), SOAK_JITTER (max ms between results, default 1500).
 * Run alone: pnpm exec playwright test e2e/voice-soak.spec.ts (it is long: about 10 s per session).
 */
const N = Number(process.env.SOAK_N ?? 300);
const SEED = Number(process.env.SOAK_SEED ?? 1);
const JITTER = Number(process.env.SOAK_JITTER ?? 1500);
/** Replay only these session numbers of the same seeded run ("95,120"): a failure is re-run in seconds, not 45 minutes. */
const ONLY = process.env.SOAK_ONLY ? new Set(process.env.SOAK_ONLY.split(",").map(Number)) : null;
const COUNTDOWN_MS = 5000; // 3 s, or 5 s when a dish carries a Check marker

function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

type Kind = "done" | "place" | "kot" | "none";
interface Want { name: string; qty: number; variant: string | null; check: boolean }
interface Dish { say: string; want: Want | null; unresolved?: "sold-out" }

const EN = ["one", "two", "three", "four"], HI = ["ek", "do", "teen", "chaar"];
const ENDINGS: Record<Exclude<Kind, "none">, string[]> = {
  done: ["done", "Done.", "ok done", "ho gaya", "bas itna", "that's all", "done karo", "add to order", "Add to order.", "add to cart", "order mein daalo", "don", "dun", "doen", "dawn", "add to border"],
  place: ["place order", "Place order.", "place the order", "order place karo", "order kar do", "place order please", "order place kar do", "confirm order", "Place order"],
  kot: ["send to kitchen", "Send to kitchen.", "kitchen bhejo", "kitchen mein bhej do", "send KOT", "KOT bhejo", "place order and send to kitchen"],
};
const WAKES = ["hey Zonov", "Hey Zonov", "hey zonov,", "hi zonov", "OK Zonov"];

interface Session {
  i: number; handsFree: boolean; wake: boolean; dishes: Dish[]; kind: Kind; ending: string; caps: boolean;
  words: boolean; splitEnd: boolean; dup: boolean; restart: boolean; noSpeech: boolean; endInterimOnly: "no" | "restart" | "network";
  revise: boolean; secondWake: boolean; abort: string | null; twoStep: boolean; jitter: number[];
}

function makeSession(i: number, r: () => number): Session {
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const qty = () => 1 + Math.floor(r() * 4);
  const qw = (q: number) => (r() < 0.3 ? HI : r() < 0.2 ? ["1", "2", "3", "4"] : EN)[q - 1];
  const pool: (() => Dish)[] = [
    () => { const q = qty(); return { say: `${qw(q)} matar paneer`, want: { name: "Matar Paneer", qty: q, variant: null, check: false } }; },
    () => { const q = qty(); return { say: `${qw(q)} ${pick(["lassi", "sweet lassi"])}`, want: { name: "Sweet Lassi", qty: q, variant: null, check: false } }; },
    () => { const q = qty(); return { say: `${qw(q)} mango lassi`, want: { name: "Mango Lassi", qty: q, variant: null, check: false } }; },
    () => { const q = qty(); return { say: `${qw(q)} ${pick(["chapati", "tandoori roti"])}`, want: { name: "Tandoori Roti", qty: q, variant: null, check: false } }; },
    () => { const q = qty(), size = pick(["half", "full", ""]); return { say: `${qw(q)} butter chicken${size ? ` ${size}` : ""}`, want: { name: "Butter Chicken", qty: q, variant: size === "full" ? "Full" : "Half", check: false } }; },
    () => { const q = qty(); return { say: `${qw(q)} dal makhani`, want: { name: "Dal Makhani", qty: q, variant: null, check: false } }; },
  ];
  const n = 1 + Math.floor(r() * 5);
  const order = [...pool.keys()].sort(() => r() - 0.5).slice(0, Math.min(n, pool.length));
  const dishes: Dish[] = order.map((k) => pool[k]());
  if (r() < 0.2) dishes.splice(Math.floor(r() * (dishes.length + 1)), 0, { say: "to garlic naan", want: { name: "Garlic Naan", qty: 2, variant: null, check: true } });
  const odd = r();
  if (odd < 0.1) dishes.push({ say: `${qw(1)} biryani`, want: { name: "Biryani?", qty: 1, variant: null, check: true } }); // a default is picked
  else if (odd < 0.18) dishes.push({ say: `${qw(1)} jeera rice`, want: null, unresolved: "sold-out" });
  const k = r();
  const kind: Kind = k < 0.45 ? "done" : k < 0.7 ? "place" : k < 0.92 ? "kot" : "none";
  const handsFree = r() < 0.55;
  const wake = handsFree && r() < 0.8;
  const end = r();
  return {
    i, handsFree, wake, dishes, kind, ending: kind === "none" ? "" : pick(ENDINGS[kind]), caps: r() < 0.25,
    words: r() < 0.7, splitEnd: r() < 0.5, dup: r() < 0.3, restart: r() < 0.3, noSpeech: r() < 0.15,
    // the ending heard only as an unfinished (interim) guess, then the recogniser ends (restart) or fails (network)
    endInterimOnly: kind !== "none" && end < 0.12 ? "restart" : kind !== "none" && end < 0.2 && !handsFree ? "network" : "no",
    revise: r() < 0.2, secondWake: wake && r() < 0.1,
    abort: (kind === "place" || kind === "kot") && end >= 0.2 && r() < 0.15 ? pick(["stop", "Stop.", "ruko", "nahi", "cancel", "wait"]) : null,
    // "done" first (the cart to check), then "place order" as its own utterance (hands-free: no wake phrase needed right after)
    twoStep: (kind === "place" || kind === "kot") && handsFree && r() < 0.25,
    jitter: Array.from({ length: 64 }, () => Math.floor((r() < 0.75 ? r() * 400 : r() * JITTER))),
  };
}

const capsOf = (t: string) => t.replace(/(^|[,.] )([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());

/** The words a recogniser would produce for this session, as results: [interim steps..., final] per phrase group. */
async function play(page: Page, s: Session) {
  let j = 0;
  const wait = () => page.waitForTimeout(s.jitter[j++ % s.jitter.length]);
  const phrase = async (text: string, opts: { finalise?: boolean } = {}) => {
    const t = s.caps ? capsOf(text) : text;
    if (s.words) {
      const ws = t.split(" ");
      for (let k = 1; k < ws.length; k++) {
        let part = ws.slice(0, k).join(" ");
        if (s.revise && /\bfour\b/.test(part)) part = part.replace(/\bfour\b/, "for"); // a recogniser guess revised in the final
        await qa(page, "interim", part); await wait();
      }
    }
    if (opts.finalise === false) { await qa(page, "interim", t); return; }
    await qa(page, "final", t);
    if (s.dup) await qa(page, "dup");
  };
  const groups: string[] = [];
  const ending = s.twoStep ? "done" : s.ending;
  const said = s.dishes.map((d) => d.say);
  if (s.secondWake && said.length > 1) said.splice(1, 0, "hey zonov");
  // dishes in 1-3 results
  let k = 0;
  while (k < said.length) { const take = 1 + Math.floor((s.jitter[k] % 3)); groups.push(said.slice(k, k + take).join(", ")); k += take; }
  if (ending && !s.splitEnd && s.endInterimOnly === "no") groups[groups.length - 1] += `, ${ending}`;
  if (s.wake) groups[0] = `${WAKES[s.i % WAKES.length]} ${groups[0]}`;
  for (let g = 0; g < groups.length; g++) {
    await phrase(groups[g]); await wait();
    if (g < groups.length - 1 && s.restart) { await qa(page, "end"); await wait(); }
    if (g < groups.length - 1 && s.noSpeech) { await qa(page, "error", "no-speech"); await wait(); }
  }
  if (ending && (s.splitEnd || s.endInterimOnly !== "no")) {
    if (s.endInterimOnly !== "no") {
      await phrase(ending, { finalise: false }); await wait();
      if (s.endInterimOnly === "restart") await qa(page, "end"); else await qa(page, "error", "network");
    } else await phrase(ending);
  }
}

interface Result { ok: boolean; why: string }

const keyOf = (l: { name: string; variant: string | null }) => `${l.name}${l.variant ? `/${l.variant}` : ""}`;
function cartOf(ts: TicketView[], m: OwnerMenu): Map<string, { qty: number; check: boolean }> {
  const out = new Map<string, { qty: number; check: boolean }>();
  const vname = new Map(Object.entries(m.variants).map(([k, v]) => [v, k.split("/")[1]]));
  for (const t of ts) for (const l of [...t.lines, ...t.more]) {
    const k = keyOf({ name: /Biryani$/.test(l.name) ? "Biryani?" : l.name, variant: l.variantId ? vname.get(l.variantId) ?? "?" : null });
    const o = out.get(k) ?? { qty: 0, check: false };
    out.set(k, { qty: o.qty + l.qty, check: o.check || l.check });
  }
  return out;
}

test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1280, height: 800 } });

test(`voice soak: ${N} random sessions (seed ${SEED})`, async ({ page, context, request }) => {
  test.setTimeout(N * 40_000 + 60_000);
  const m = await seedOwner(request);
  const srv = apiSession(request, m);
  await srv.login();
  const serverOrders = async () => srv.get<ServerOrder[]>("/orders");
  const serverKots = async () => srv.get<{ order_id: string }[]>("/kot");
  await context.grantPermissions(["microphone"]);
  await installHarness(page, { silenceMs: 2500, busyAfterCloseMs: 400 }); // Chrome-like: a start right after a stop / abort throws
  const errors: string[] = [];
  page.on("console", (msg) => { if (msg.type() === "error" && !/Failed to load resource|favicon|ERR_ABORTED/.test(msg.text())) errors.push(msg.text()); });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await openAs(page, m.token, "/pos", m.refresh);
  const r = rng(SEED);
  const failures: { s: Session; why: string }[] = [];
  const byKind: Record<string, { n: number; fail: number }> = {};
  const vname = (name: string, v: string | null) => (v ? m.variants[`${name}/${v}`] : null);
  for (let i = 0; i < N; i++) {
    const s = makeSession(i, r);
    if (ONLY && !ONLY.has(i)) continue;
    const tag = `${s.kind}${s.twoStep ? "+two-step" : ""}${s.abort ? "+stop" : ""}${s.dishes.some((d) => d.unresolved) ? "+sold-out" : ""}${s.dishes.some((d) => d.say.endsWith("biryani")) ? "+ambiguous" : ""}`;
    byKind[tag] ??= { n: 0, fail: 0 }; byKind[tag].n++;
    // a clean counter: no tickets, the hands-free switch as this session wants it
    await wipeTickets(page);
    await page.evaluate((hf) => { if (hf) localStorage.removeItem("pos.wakeOff"); else localStorage.setItem("pos.wakeOff", "1"); }, s.handsFree);
    await page.reload();
    await expect(page.getByRole("button", { name: /^Matar Paneer,/ }).first()).toBeVisible();
    const before = await tickets(page);
    if (before.some((t) => t.lines.length || t.more.length || t.placed)) { await wipeTickets(page); await page.reload(); await expect(page.getByRole("button", { name: /^Matar Paneer,/ }).first()).toBeVisible(); }
    const ordersBefore = new Set((await serverOrders()).map((o) => o.id));
    const kotsBefore = (await serverKots()).length;
    errors.length = 0;
    let res: Result = { ok: true, why: "" };
    try {
      if (s.handsFree) await expect.poll(() => qa(page, "listening"), { timeout: 8000 }).toBeGreaterThan(0);
      if (!s.wake) {
        await page.getByRole("button", { name: /^Voice order/ }).click();
        await expect(page.getByTestId("voice-live")).toBeVisible();
        // the tapped recogniser may start a moment later (a start right after the hands-free one was aborted is retried): speak once it listens
        await expect.poll(() => page.evaluate(() => { const w = window as unknown as { __qa: { listening: () => number } }; return w.__qa.listening(); }), { timeout: 10_000 }).toBeGreaterThan(0);
      }
      await play(page, s);
      if (s.twoStep) {
        // the cart first ("done" closes the sheet), then "place order" on its own: a follow-up needs no wake phrase
        await expect.poll(async () => cartOf(await tickets(page), m).size, { timeout: 8000 }).toBeGreaterThan(0);
        await expect(page.getByRole("dialog")).toHaveCount(s.dishes.some((d) => d.unresolved) ? 1 : 0);
        if (await page.getByRole("dialog").count()) await page.keyboard.press("Escape");
        await expect.poll(() => qa(page, "listening"), { timeout: 8000 }).toBeGreaterThan(0);
        await page.waitForTimeout(s.jitter[1]);
        await qa(page, "final", s.caps ? capsOf(s.ending) : s.ending);
      }
      if (s.abort) {
        await expect(page.getByTestId("voice-countdown")).toBeVisible({ timeout: 6000 });
        await page.waitForTimeout(200 + (s.jitter[2] % 1200));
        await qa(page, "final", s.abort); // said after the command, in the same recogniser session
      }
      const addable = s.dishes.filter((d) => d.want).map((d) => d.want!);
      const unresolved = s.dishes.some((d) => d.unresolved);
      const placeKind = s.kind === "place" || s.kind === "kot";
      const expectCart = s.kind !== "none";
      const expectPlaced = placeKind && !s.abort;
      const deadline = Date.now() + (placeKind ? COUNTDOWN_MS + 9000 : 9000);
      const check = async (): Promise<string | null> => {
        const cart = cartOf(await tickets(page), m);
        const want = new Map<string, { qty: number; check: boolean }>();
        if (expectCart) for (const w of addable) { const k = keyOf(w); const o = want.get(k) ?? { qty: 0, check: false }; want.set(k, { qty: o.qty + w.qty, check: o.check || w.check }); }
        const a = [...cart].map(([k, v]) => `${k}x${v.qty}`).sort().join(","), b = [...want].map(([k, v]) => `${k}x${v.qty}`).sort().join(",");
        if (a !== b) return `cart [${a}] != expected [${b}]`;
        const fresh = (await serverOrders()).filter((o) => !ordersBefore.has(o.id));
        if (!expectPlaced && fresh.length) return `placed ${fresh.length} order(s) without a place phrase${s.abort ? " (stop was said)" : ""}`;
        if (expectPlaced) {
          if (fresh.length !== 1) return `expected 1 new order, got ${fresh.length}`;
          const got = fresh[0].lines.map((l) => l.item_name.replace(/ \([^)]*\)$/, "")).map((n, k) => ({ n, l: fresh[0].lines[k] })).map(({ n, l }) => `${/Biryani$/.test(n) ? "Biryani?" : n}${l.variant_id ? `/${Object.entries(m.variants).find(([, v]) => v === l.variant_id)?.[0].split("/")[1]}` : ""}x${l.quantity}`);
          const merged = new Map<string, number>();
          for (const g of got) { const [k, q] = g.split(/x(?=\d+$)/); merged.set(k, (merged.get(k) ?? 0) + Number(q)); }
          const ga = [...merged].map(([k, q]) => `${k}x${q}`).sort().join(",");
          if (ga !== b) return `order lines [${ga}] != expected [${b}]`;
          void vname;
        }
        const kots = (await serverKots()).length - kotsBefore;
        if (expectPlaced && kots !== 1) return `expected 1 kitchen ticket, got ${kots}`;
        if (!expectPlaced && kots !== 0) return `sent ${kots} kitchen ticket(s) without a place / send phrase`;
        const dialogs = await page.getByRole("dialog").count();
        // two-step: the harness itself closed the sheet with the sold-out dish before saying the command
        const sheetShouldStay = (unresolved && !s.twoStep) || s.kind === "none";
        if (sheetShouldStay && dialogs === 0) return "the sheet closed although something was left to resolve";
        if (!sheetShouldStay && dialogs > 0) return `the sheet is still open (${(await page.getByRole("dialog").first().getAttribute("aria-label")) ?? (await page.getByRole("dialog").first().innerText()).slice(0, 120).replace(/\s+/g, " ")})`;
        if (s.kind === "done") for (const w of addable) if (w.check && !cart.get(keyOf(w))?.check) return `${w.name} not marked Check`;
        return null;
      };
      let why: string | null = "not checked";
      while (Date.now() < deadline) { why = await check(); if (!why) break; await page.waitForTimeout(300); }
      if (!why) { await page.waitForTimeout(700); why = await check(); } // stable: no late duplicate
      if (!why) {
        // late results for recognisers that were stopped / aborted, then nothing may change
        const n = await qa(page, "count");
        for (let b = 1; b < Math.min(n, 3); b++) await qa(page, "late", b, "two mango lassi, place order");
        await page.waitForTimeout(500);
        why = await check();
        if (why) why = `after a late result: ${why}`;
      }
      if (!why && errors.length) why = `console: ${errors[0].slice(0, 200)}`;
      res = why ? { ok: false, why } : res;
    } catch (e) {
      res = { ok: false, why: `harness: ${(e as Error).message.split("\n")[0].slice(0, 200)}` };
    }
    if (!res.ok) {
      byKind[tag].fail++;
      failures.push({ s, why: res.why });
      if (process.env.SOAK_SHOTS) await page.screenshot({ path: `test-results/soak-fail-${SEED}-${i}.png` }).catch(() => {});
    }
    // leave nothing open for the next session
    if (await page.getByRole("dialog").count()) await page.keyboard.press("Escape").catch(() => {});
  }
  const lines = failures.map((f) => `#${f.s.i} ${f.s.kind} "${f.s.ending}" abort=${f.s.abort} twoStep=${f.s.twoStep} hf=${f.s.handsFree} wake=${f.s.wake} dishes=[${f.s.dishes.map((d) => d.say).join("; ")}] split=${f.s.splitEnd} words=${f.s.words} dup=${f.s.dup} restart=${f.s.restart} noSpeech=${f.s.noSpeech} endInterim=${f.s.endInterimOnly} revise=${f.s.revise} secondWake=${f.s.secondWake}\n    -> ${f.why}`);
  const summary = `SOAK seed=${SEED} n=${N} failures=${failures.length} (${((failures.length / N) * 100).toFixed(1)}%)\n${Object.entries(byKind).map(([k, v]) => `  ${k}: ${v.fail}/${v.n}`).join("\n")}\n${lines.join("\n")}`;
  console.log(summary);
  await test.info().attach("soak-summary.txt", { body: summary, contentType: "text/plain" });
  expect(failures.length, summary).toBe(0);
});
