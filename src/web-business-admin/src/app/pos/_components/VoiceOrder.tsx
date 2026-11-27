"use client";

import { getUserMediaQueued } from "@/lib/gum";
import { LANGUAGES_ENABLED } from "@/lib/i18n";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Ban, Check, Cpu, Keyboard, Mic, MicOff, RotateCcw, Send, Sparkles, Square, Trash2, TriangleAlert, User } from "lucide-react";
import { Money, QtyStepper, Spinner, toast } from "@/components/ui";
import { Button, Dialog, IconButton, Input, Textarea } from "@chilli/ui";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { createOrFindCustomer, customerLabel, phoneHint, phoneProblem } from "@/lib/customers";
import { canRecogniseOffline, lastSpeechError, liveSpeechUsable, LiveListener, resetSpeechBroken, speechCtor, type LiveFailure, type LiveUpdate } from "@/lib/liveSpeech";
import { formatCurrency, mulMoney, sumMoney } from "@/lib/money";
import type { Category, Customer, DiningTable, MenuItem, OrderType, TableStatus, VoiceAlias, VoiceOrder } from "@/lib/types";
import { aliasPhrase, buildVoiceMenu, parseOrder, type ParsedOrder, type VoiceMenu } from "@/lib/voiceParse";
import { detectCommand } from "@/lib/voiceCommands";
import { doneMenu, splitDone } from "@/lib/voiceDone";
import { handsFreeLabel, rearmDecision, sleepRetryDelay, type RearmState, type Trigger } from "@/lib/handsFree";
import { afterWake, confirmNearMiss, explainWake, lastWakeHeard, noteNearMiss, noteWakeHeard, stripWakes, wakeSensitivity } from "@/lib/wakeWord";
import { micLog } from "@/lib/micLog";
import { directDecision, directOn, rateOk } from "@/lib/voiceDirect";
import { normalizeModifiers } from "@/lib/voiceModifiers";
import { gapDecision, MicGuard, type Utterance } from "@/lib/micGuard";
import { detectorOn, WakeDetector, type Detection } from "@/lib/wakeDetector";
import { useVegOnly } from "@/lib/vegOnly";
import { dishLessonAliases, dishLessons, learnDish, onDishLessons, touchDish } from "@/lib/dishLearn";
import { isVegOnlyMatch } from "@/lib/menuAdmin";
import { MicDebug } from "./MicDebug";
import { VoiceSettings } from "./VoiceSettings";
import { apiRequest } from "@/lib/api";
import { refreshWakeConfig, SHARE_CONFIG_EVERY_MS, setShareTransport, shareSample } from "@/lib/voiceShare";
import { TYPE_NAME } from "./tickets";
import { useCan } from "@/lib/useRole";
import { commandWords, countdownSeconds, countdownText, FOLLOW_UP_MS, holdText, intentFor, intentStep, pickDefault, pickedNote, saysStop, type Intent } from "./voiceFlow";
import { voiceCountdown } from "@/lib/voiceSettings";
import { mergeSameDishes } from "./voiceSheet";
import { blockers, commandView, doneHolds, type DoneState, doneVerdict, fromClarifications, holdMessage, isSoft, lineSize, pickCommand, reasonText, sizeSwitch, understoodBy, type SheetCommand, type Source } from "./voiceSheet";

/** Owner 2026-11-13: the "Listening / Paused" chip, the "Direct mode ON" chip and the "Mic debug" box are not shown to staff any more (testing-phase aids).
 *  Voice itself is unchanged. Developers and the voice e2e harness can show them again with localStorage `chilli.showVoiceChips` = "1". */
const SHOW_CHIPS_KEY = "chilli.showVoiceChips";
function useShowVoiceChips(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => { try { setOn(localStorage.getItem(SHOW_CHIPS_KEY) === "1"); } catch { /* storage blocked: stay hidden */ } }, []);
  return on;
}


/** Recordings stop by themselves after this long (the server takes up to 10 MB; a minute of opus is ~250 KB). */
export const MAX_RECORD_SECONDS = 60;
/** Live (on-device) listening sends nothing anywhere, so it may run longer. */
export const MAX_LIVE_SECONDS = 120;

/** What "Add to order" hands to the till: menu items + quantities only (prices come from the cart logic as usual). */
export interface VoiceApply {
  lines: { item: MenuItem; variantId: string | null; qty: number; note?: string | null; /** Added by "done" with a doubt: the cart line is marked "Check". */ check?: boolean }[];
  customer: Customer | null;
  type: OrderType | null;
  tableId: string | null;
  /** Which bill gets the lines: null = the active ticket, "new" = a new ticket (lowest free number), a number = that bill (created with exactly that number when it is not open yet). */
  bill: number | "new" | null;
  /** The chosen table already has an order: "join" adds these dishes to that order, "separate" starts a second order (same choices as the counter). */
  tableMode?: { mode: "join" | "separate"; orderId: string | null } | null;
}

/**
 * An open ticket as the sheet's "Add to" selector sees it. `locked` = billed / paid: nothing can be added.
 * `placed` = already on the server (placed / in the kitchen): dishes still go in, as "more items" for the next "Add to order".
 */
export interface VoiceBill { id: string; no: number; itemCount: number; locked: boolean; placed?: boolean; tableId?: string | null }

// ---- spoken language (remembered per device) ----
export type VoiceLang = "en" | "hi" | "pa" | "auto";
export const VOICE_LANGS: { value: VoiceLang; short: string; label: string }[] = [
  { value: "en", short: "EN", label: "English (live)" },
  { value: "hi", short: "HI", label: "Hindi / Hinglish" },
  { value: "pa", short: "PA", label: "Punjabi" },
  { value: "auto", short: "Auto", label: "Other / auto" },
];
const LANG_KEY = "pos.voiceLang";
const langListeners = new Set<() => void>();
function readLang(): VoiceLang {
  try { const v = localStorage.getItem(LANG_KEY); return VOICE_LANGS.some((l) => l.value === v) ? (v as VoiceLang) : "en"; } catch { return "en"; }
}
function writeLang(v: VoiceLang) {
  try { localStorage.setItem(LANG_KEY, v); } catch { /* private mode: kept for this page only */ }
  memLang = v;
  langListeners.forEach((f) => f());
}
let memLang: VoiceLang | null = null;
const subscribeLang = (f: () => void) => { langListeners.add(f); return () => langListeners.delete(f); };
const langSnapshot = () => memLang ?? (memLang = readLang());

// ---- hands-free "Hey Zonov": on at every app open (the mic presses itself when the phrase is heard); the Mic on/off switch next to the mic turns it off ----
/** Test hook only: "1" keeps hands-free off so specs about the tapped mic run without a background listener. */
const OFF_KEY = "pos.wakeOff";
// The mic is ON every time the app opens or reloads; the switch turns it off only until the next open (memory only), never for good.
// localStorage OFF_KEY is still honoured as the e2e test hook.
function readAuto(): boolean { try { return localStorage.getItem(OFF_KEY) !== "1"; } catch { return true; } }
const autoListeners = new Set<() => void>();
const subscribeAuto = (f: () => void) => { autoListeners.add(f); return () => { autoListeners.delete(f); }; };
let memAuto: boolean | null = null;
const autoSnapshot = () => memAuto ?? (memAuto = readAuto());
/** The visible hands-free switch (off lasts until the next app open). */
function writeAuto(on: boolean) {
  try { if (on) localStorage.removeItem(OFF_KEY); } catch { /* private mode: this page only */ }
  memAuto = on;
  autoListeners.forEach((f) => f());
}
/** Hands-free: the order that follows "Hey Zonov" settles after this long without speech (a test hook can shorten it). Waiting for the wake phrase never times out. */
export const AUTO_SILENCE_MS = 8_000;
/** An unfinished (interim) "done" / command that stays the same this long counts as said (some recognisers never finalise it). */
const SETTLE_MS = 900;
const silenceMs = () => (typeof window !== "undefined" && (window as unknown as { __POS_VOICE_SILENCE_MS?: number }).__POS_VOICE_SILENCE_MS) || AUTO_SILENCE_MS;
const anotherDialogOpen = () => !!document.querySelector('[role="dialog"],[role="alertdialog"]');
/** "granted" | "denied" | "prompt" | "unknown" (no Permissions API for the microphone, e.g. Safari). */
async function micPermission(): Promise<"granted" | "denied" | "prompt" | "unknown"> {
  try {
    if (!navigator.permissions?.query) return "unknown";
    // never wait for ever: a permission query that does not settle would keep hands-free "starting" until a reload
    const r = await Promise.race([navigator.permissions.query({ name: "microphone" as PermissionName }), new Promise<null>((ok) => setTimeout(() => ok(null), 1500))]);
    return r ? r.state : "unknown";
  } catch { return "unknown"; }
}
type IdleNote = "tap" | "sleeping" | "blocked" | "nomic" | null;
/** Test hook: the hands-free retry delays while sleeping (ms), shortened by specs. */
const sleepDelay = (n: number) => (typeof window !== "undefined" && (window as unknown as { __POS_VOICE_RETRY_MS?: number }).__POS_VOICE_RETRY_MS) || sleepRetryDelay(n);

const EMPTY_LESSONS: ReturnType<typeof dishLessons> = [];

interface DraftLine {
  key: string; itemId: string; variantId: string | null; qty: number; note: string | null; heard: string; issues: string[];
  alternatives?: string[]; pending?: boolean;
  /** The heard phrase as the till learns it (voiceParse aliasPhrase); absent on AI lines (worked out from `heard` if needed). */
  phrase?: string;
  /** Staff chose this line's dish themselves (for an unmatched phrase, or in the picker): taught to the till on "Add to order". */
  learn?: boolean;
  /** "Remember this for next time" (on by default for a dish staff chose): unticked = this choice teaches nothing. */
  remember?: boolean;
  /** Placed through a phrase the till learnt (on this device or on the server). */
  learnt?: boolean;
  /** Several dishes fit ("ek biryani"): staff tap one of itemId + alternatives; never added before that. */
  ask?: boolean;
  /** No size was said: the line has the default size (Half), shown with a one-tap switch. */
  defaulted?: boolean;
  /** The same dish was said this many times (voiceSheet mergeSameDishes): one line, the quantities added up. */
  said?: number;
  /** Keys of the lines merged into this one (dropping or editing it settles them all). */
  mergedKeys?: string[];
  /** Staff tapped "Add anyway" on a dish the counter's Veg only filter hides. */
  anyway?: boolean;
}
interface Draft {
  transcript: string | null;
  lines: DraftLine[];
  unmatched: { key: string; text: string; pending?: boolean; phrase?: string }[];
  name: string; phone: string; phoneHeardBad: boolean;
  type: OrderType | null; useType: boolean;
  tableId: string | null; tableLabel: string | null; useTable: boolean;
  /** "current" (the active ticket), "new", or `no:N` (bill N). */
  bill: string;
  source: Source; lang: VoiceLang; aiImproved: number;
  /** "Place order" / "send to kitchen" / "cancel" said at the end: run only after the confirm tap. */
  command: SheetCommand | null;
  /** The server asked the AI model for this reply. */
  modelUsed: boolean;
  /** The table said fits several tables: one-tap choices. */
  tableChoices: string[];
  /** The chosen table already has an order: staff chose to add to it or to start a separate one. */
  tableMode: "join" | "separate" | null;
}
/** What staff changed on lines that came from live parsing: kept while the transcript keeps growing. */
interface LiveMeta { touched: Set<string>; dropped: Set<string>; name: boolean; phone: boolean; type: boolean; table: boolean; bill: boolean; command: boolean }
const freshMeta = (): LiveMeta => ({ touched: new Set(), dropped: new Set(), name: false, phone: false, type: false, table: false, bill: false, command: false });

type Stage = "closed" | "live" | "starting" | "recording" | "typing" | "busy" | "confirm" | "countdown";

let seq = 0;
const nextKey = () => `v${++seq}`;

function pickMime(): string {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return "";
  return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
}

/** Wall clock for the timers (outside the component: only ever read in event handlers and intervals). */
const nowMs = () => Date.now();
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/**
 * A reply from the server (validated ids) as a draft. Lines keep the size said, else the default size (Half); the
 * server's `clarifications` become ask lines ("which dish?"), never dropped and never guessed. The table is re-read on
 * this device from the transcript (exact label first: "table 3" -> T3), because older servers match AC3 for it.
 */
function toDraft(r: VoiceOrder, byId: Map<string, MenuItem>, tables: DiningTable[], source: Source, lang: VoiceLang, vmenu?: VoiceMenu): Draft {
  const lines: DraftLine[] = [];
  const unmatched = r.unmatched.map((text) => ({ key: nextKey(), text }));
  for (const l of r.lines) {
    const item = byId.get(l.item_id);
    if (!item) { unmatched.push({ key: nextKey(), text: l.heard_text || l.item_name }); continue; } // menu on this screen is older
    const size = lineSize(item, l.variant_id, l.defaulted ?? !l.variant_id);
    lines.push({ key: nextKey(), itemId: item.id, variantId: size.variantId, defaulted: size.defaulted, qty: Math.min(Math.max(l.quantity, 1), 99), note: l.note, heard: l.heard_text,
      issues: l.issues.filter((i) => !/^option|default/i.test(i) || !size.defaulted) });
  }
  const c = fromClarifications(r, (id) => byId.has(id));
  for (const a of c.asks) lines.push({ key: nextKey(), itemId: a.options[0], alternatives: a.options.slice(1), ask: true, variantId: null, qty: a.qty, note: a.note, heard: a.heard, issues: [] });
  for (const a of c.check) {
    const item = byId.get(a.options[0])!;
    const size = lineSize(item, null, true);
    lines.push({ key: nextKey(), itemId: item.id, variantId: size.variantId, defaulted: size.defaulted, qty: a.qty, note: a.note, heard: a.heard, issues: [reasonText(a.reason)] });
  }
  for (const t of c.unmatched) unmatched.push({ key: nextKey(), text: t });
  let table = r.table_id ? tables.find((t) => t.id === r.table_id) : undefined;
  let tableChoices: string[] = [];
  let tableLabel = table?.label ?? r.table_label;
  if (vmenu && r.transcript) {
    const local = parseOrder(r.transcript, vmenu, { tables });
    if (local.tableId || local.tableChoices.length) {
      table = local.tableId ? tables.find((t) => t.id === local.tableId) : undefined;
      tableChoices = local.tableChoices; tableLabel = table?.label ?? local.tableLabel;
    }
  }
  const phoneBad = !!r.customer.phone_heard && !r.customer.phone;
  return {
    transcript: r.transcript, lines, unmatched,
    name: r.customer.name ?? "", phone: r.customer.phone ?? r.customer.phone_heard ?? "", phoneHeardBad: phoneBad,
    type: r.order_type, useType: !!r.order_type,
    tableId: table?.id ?? null, tableLabel, useTable: !!table,
    bill: r.bill_no ? `no:${r.bill_no}` : r.new_bill ? "new" : "current",
    source, lang, aiImproved: 0,
    command: pickCommand(null, r.command), modelUsed: !!r.model_used, tableChoices, tableMode: null,
  };
}

/**
 * Folds a fresh on-device parse of the WHOLE transcript into the draft on screen. Lines are keyed by where their words
 * start in the transcript, so they stay put as speech arrives; anything staff touched, dropped or typed wins.
 */
function mergeParsed(prev: Draft | null, p: ParsedOrder, meta: LiveMeta, transcript: string, source: Source, lang: VoiceLang, byId: Map<string, MenuItem>, command: SheetCommand | null = null): Draft {
  const old = new Map((prev?.lines ?? []).map((l) => [l.key, l]));
  const lines: DraftLine[] = [];
  const seen = new Set<string>();
  for (const l of p.lines) {
    if (meta.dropped.has(l.key)) continue;
    seen.add(l.key);
    const o = old.get(l.key);
    if (o && meta.touched.has(l.key)) { lines.push({ ...o, pending: l.pending }); continue; }
    const item = byId.get(l.itemId);
    const size = l.ask || !item ? { variantId: null, defaulted: false } : lineSize(item, l.variantId, l.defaulted);
    lines.push({ key: l.key, itemId: l.itemId, variantId: size.variantId, defaulted: size.defaulted, qty: l.qty, note: l.note, heard: l.heard,
      issues: l.ask ? [] : l.issues, alternatives: l.alternatives, ask: l.ask, pending: l.pending, phrase: l.phrase, learnt: l.learnt });
  }
  for (const l of prev?.lines ?? []) if (!seen.has(l.key) && (meta.touched.has(l.key) || !l.key.startsWith("L"))) lines.push({ ...l, pending: false });
  const unmatched: Draft["unmatched"] = p.unmatched.filter((u) => !meta.dropped.has(u.key));
  for (const u of prev?.unmatched ?? []) if (!u.key.startsWith("U")) unmatched.push(u); // from the AI or typed
  const name = meta.name ? prev?.name ?? "" : p.name ?? prev?.name ?? "";
  const phone = meta.phone ? prev?.phone ?? "" : p.phone ?? p.phoneHeard ?? prev?.phone ?? "";
  const keepType = meta.type || !p.type;
  const keepTable = meta.table || (!p.tableLabel && !p.tableChoices.length);
  return {
    transcript: transcript || null, lines, unmatched, name, phone,
    phoneHeardBad: meta.phone ? prev?.phoneHeardBad ?? false : !!p.phoneHeard && !p.phone,
    type: keepType ? prev?.type ?? null : p.type, useType: keepType ? prev?.useType ?? false : true,
    tableId: keepTable ? prev?.tableId ?? null : p.tableId, tableLabel: keepTable ? prev?.tableLabel ?? null : p.tableLabel,
    useTable: keepTable ? prev?.useTable ?? false : !!p.tableId,
    tableChoices: keepTable ? prev?.tableChoices ?? [] : p.tableChoices,
    tableMode: keepTable ? prev?.tableMode ?? null : null,
    // the spoken bill follows the transcript (the last one said wins) unless staff chose a bill on the sheet
    bill: meta.bill ? prev?.bill ?? "current" : p.billNo ? `no:${p.billNo}` : p.newBill ? "new" : "current",
    source: prev?.source === "ai-live" ? "ai-live" : source, lang, aiImproved: prev?.aiImproved ?? 0,
    command: command ?? (meta.command ? prev?.command ?? null : null), modelUsed: prev?.modelUsed ?? false,
  };
}

/** The transcript split into the order and a command said at its end ("..., place order"). */
function splitCommand(text: string, vmenu: VoiceMenu): { rest: string; command: SheetCommand | null; done: boolean } {
  // "done" first: it is never part of a dish, a table or a command ("butter chicken done"); a command before it keeps its confirm tap
  const d = splitDone(text, doneMenu(vmenu));
  const c = detectCommand(d.rest, vmenu);
  return { rest: c.command ? splitDone(c.rest, doneMenu(vmenu)).rest : d.rest, command: c.command, done: d.done };
}

const digitsOf = (p: string) => p.replace(/\D/g, "");

/** An existing customer for the spoken name / phone: same phone (normalised digits), else exactly one with that name. */
function findCustomer(customers: Customer[], name: string, phone: string): Customer | undefined {
  const d = digitsOf(phone).replace(/^0+/, "");
  if (d.length >= 7) return customers.find((c) => c.phone && digitsOf(c.phone).endsWith(d));
  if (!phone && name) {
    const same = customers.filter((c) => (c.name ?? "").trim().toLowerCase() === name.trim().toLowerCase());
    if (same.length === 1) return same[0];
  }
  return undefined;
}

/** The wake words at the start of a server transcript after a detector wake ("Hey Zonov", "hey John of", "jono ...") dropped. */
export const dropWakeWords = (t: string) => t.replace(/^\s*(?:(?:hey|hay|hi|he|a|ok|okay|hello)[\s,]+)?(?:zone of|zone off|joe nov|john of|zo nov|[zjs][aeiou]?h?n\w{0,4})[\s,.!?]*/i, "").trim();

const langLabel = (l: VoiceLang) => VOICE_LANGS.find((x) => x.value === l)!.label.replace(" (live)", "");
/** The longer words behind the short "Understood on device" / "Checked with AI" note (its tooltip and screen-reader text). */
function sourceDetail(d: Draft): string {
  const base = d.source === "live" ? "Matched to the menu on this device while you spoke; nothing was sent to the AI."
    : d.source === "typed" ? "Matched to the menu on this device from the typed text; nothing was sent to the AI."
      : d.source === "ai-audio" ? `The AI read the recording (${langLabel(d.lang)}).`
        : d.modelUsed ? "The server was not sure and checked the words with the AI model." : "The server's own parser matched the words (no AI model).";
  return d.aiImproved ? `${base} The server matched ${d.aiImproved} more ${d.aiImproved === 1 ? "phrase" : "phrases"}.` : base;
}

/**
 * Mic button + language switch + the whole voice flow. English with a browser speech recogniser: LIVE — words are
 * transcribed while staff speak and matched to the menu ON THE DEVICE, lines appear as they talk. Other languages, or
 * no recogniser: record -> the AI reads the audio. Typed text: on-device first, the AI only when nothing matched.
 * Every path ends in the same editable CONFIRM sheet: nothing reaches the ticket, the kitchen or a bill without
 * "Add to order", and prices / GST always come from the menu.
 */
export function VoiceOrderButton({ online, disabled, items, cats, tables, customers, aliases, currency, ticketKey, claims, bills, currentLocked, nextNo, onApply, onUndoApply, onCustomerCreated, onLearnt, onCommand, commandCheck, isSoldOut, tableStatus }: {
  online: boolean;
  /** No active ticket, or it is busy. A placed ticket does not disable voice: the order then goes to another or a new bill. */
  disabled: boolean;
  items: MenuItem[]; cats: Category[]; tables: DiningTable[]; customers: Customer[];
  /** Phrases the restaurant taught the till (loaded and cached for offline with the menu). */
  aliases?: VoiceAlias[];
  currency: string;
  /** Every open ticket (for "Add to"), whether the ACTIVE one is locked (billed / paid), and the number a "New bill" would get. */
  bills: VoiceBill[]; currentLocked: boolean; nextNo: number;
  /** The active ticket's id: a new ticket re-arms auto-listen. */
  ticketKey: string | null;
  /** Table id -> labels ("Bill 2") of OTHER unplaced tickets that already picked it. */
  claims?: Map<string, string[]>;
  /** false = the ticket could not take the lines (placed meanwhile); the sheet stays open. */
  onApply: (a: VoiceApply) => string | null | Promise<string | null>;
  /** Undo of an add made by saying "done": the dishes it added come off the ticket again. */
  onUndoApply?: (ticketId: string, lines: VoiceApply["lines"]) => void;
  /** A spoken command, run on the ticket the lines went to ("place", "kot") or the active one ("clear"): what happened, in words. */
  onCommand?: (c: SheetCommand, ticketId: string | null) => void | Promise<void | { ok: boolean; say: string }>;
  /** Why a spoken place / send cannot run on that ticket now (empty cart, dine-in without a table, billed, busy...), or null. */
  commandCheck?: (c: SheetCommand, ticketId: string | null, sheet?: { items: number; type: OrderType | null; tableId: string | null }) => string | null;
  /** Sold out today (the counter's rule): such a line cannot be added. */
  isSoldOut?: (item: MenuItem) => boolean;
  /** Live table states: a table with an order gets the counter's choice (add to that order / separate order). */
  tableStatus?: Map<string, TableStatus>;
  onCustomerCreated: (c: Customer) => void;
  /** A correction was learnt by the server: the till uses it straight away. */
  onLearnt?: (a: VoiceAlias) => void;
}) {
  const showVoiceChips = useShowVoiceChips();
  const [stage, setStage] = useState<Stage>("closed");
  const [secs, setSecs] = useState(0);
  const [micNote, setMicNote] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraftRaw] = useState<Draft | null>(null);
  // Business type (docs/BUSINESS_TYPES.md): a kitchen without dine-in never gets a Dine-in / Outdoor type or a table from what was
  // heard ("dine in table 5"); staff choose takeaway or delivery. Same rule as the server's voice parsing.
  const { biz } = useCan();
  const orderTypes = biz.order_types;
  const setDraft: typeof setDraftRaw = (u) => setDraftRaw((prev) => {
    const d0 = typeof u === "function" ? u(prev) : u;
    const picked = d0 && d0.lines.some((l) => l.ask) ? { ...d0, lines: d0.lines.map(pickFor) } : d0;
    // the same dish said again (also as another spelling, or after a default pick): one line, the quantity goes up
    const d = picked && picked.lines.length > 1 ? { ...picked, lines: mergeLines(picked.lines) } : picked;
    if (!d || !d.type || orderTypes.includes(d.type)) return d;
    return { ...d, type: null, useType: false, tableId: null, tableLabel: null, useTable: false };
  });
  // Several dishes fit a word ("biryani"): a default is picked (voiceFlow.ts pickDefault), never a block; the line keeps the
  // others behind its Change select and carries a Check note (the cart marks it Check too). Owner rule 2026-11.
  const menuIndex = useMemo(() => new Map(items.map((i, k) => [i.id, k])), [items]);
  // Voice follows the counter's menu visibility: with "Veg only" on, a non-veg dish is never added by voice (owner, 2026-11-02;
  // the same rule as MenuPanel: only when the menu has both kinds). Category and search are browsing aids, not rules.
  const [vegOnly] = useVegOnly();
  const canVeg = useMemo(() => items.some(isVegOnlyMatch) && !items.every(isVegOnlyMatch), [items]);
  const vegHidden = (id: string) => { if (!vegOnly || !canVeg) return false; const it = items.find((i) => i.id === id); return !!it && !isVegOnlyMatch(it); };
  const aliasOf = useMemo(() => new Map((aliases ?? []).map((a) => [a.phrase.trim().toLowerCase(), a.menu_item_id])), [aliases]);
  function mergeLines(lines: DraftLine[]): DraftLine[] {
    const keysOf = new Map<string, string[]>();
    const merged = mergeSameDishes(lines.map((l) => ({ ...l, said: undefined })), (k) => meta.current.touched.has(k));
    // remember which keys went into which line (first key wins)
    const firstOf = new Map(merged.map((l) => [`${l.itemId}|${l.variantId ?? ""}|${(l.note ?? "").trim().toLowerCase()}`, l.key]));
    for (const l of lines) {
      if (l.ask || l.pending || meta.current.touched.has(l.key)) continue;
      const first = firstOf.get(`${l.itemId}|${l.variantId ?? ""}|${(l.note ?? "").trim().toLowerCase()}`);
      if (first && first !== l.key) keysOf.set(first, [...(keysOf.get(first) ?? []), l.key]);
    }
    return merged.map((l) => (keysOf.has(l.key) ? { ...l, mergedKeys: keysOf.get(l.key) } : l));
  }
  function pickFor(l: DraftLine): DraftLine {
    if (!l.ask) return l;
    const options = [l.itemId, ...(l.alternatives ?? [])].filter((id, k, a) => a.indexOf(id) === k && items.some((i) => i.id === id));
    const id = pickDefault(options, l.heard, { order: (x) => menuIndex.get(x) ?? 1e9, name: (x) => items.find((i) => i.id === x)?.name ?? "",
      // a dish hidden by Veg only or sold out is never the default when another fits ("biryani" in Veg only -> Veg Biryani)
      soldOut: (x) => { const it = items.find((i) => i.id === x); return !!it && (!!isSoldOut?.(it) || vegHidden(x)); }, alias: (h) => aliasOf.get(h) ?? null });
    const item = items.find((i) => i.id === id);
    if (!item) return l;
    const size = lineSize(item, null, true);
    return { ...l, itemId: id, alternatives: options.filter((x) => x !== id), ask: false, variantId: size.variantId, defaulted: size.defaulted, issues: [pickedNote(options.length)] };
  }
  const [heard, setHeard] = useState<LiveUpdate>({ finalText: "", interim: "" });
  const [phoneErr, setPhoneErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [improving, setImproving] = useState(false);
  const [onDevice, setOnDevice] = useState(false); // live listening without the internet (Chrome on-device model)
  const lang = useSyncExternalStore(subscribeLang, langSnapshot, () => "en" as VoiceLang);
  const auto = useSyncExternalStore(subscribeAuto, autoSnapshot, () => false);
  const [quiet, setQuiet] = useState(false); // auto-listening in the background of the till: no sheet until someone speaks
  const [idleNote, setIdleNote] = useState<IdleNote>(null);
  const [woke, setWoke] = useState(false); // this sheet was opened by "Hey Zonov"
  const [trouble, setTrouble] = useState<string | null>(null);
  const [srAlive, setSrAlive] = useState(false); // Chrome REALLY started the recogniser (onstart / audiostart) // the background recogniser keeps failing ("network"...)
  const autoRef = useRef(false);
  // "done" / "place order" / "send to kitchen" was said: QUEUED, the effect below runs it once the sheet is ready (never dropped
  // while the server is still reading the order or an add is saving; voiceFlow.ts intentStep)
  const [intent, setIntent] = useState<Intent | null>(null);
  const [doneHeld, setDoneHeld] = useState<{ added: number; command?: "kot" } | null>(null); // "done" left something unresolved on the sheet (added: dishes it did add)
  // a spoken place / send: the visible countdown before it runs by itself (stop / cancel / ruko / nahi or a tap cancel it)
  const [countdown, setCountdown] = useState<{ from: "place" | "kot"; endsAt: number; total: number; checks: string[] } | null>(null);
  const [left, setLeft] = useState(0);
  const [outcome, setOutcome] = useState("");
 // the voice settings dialog (countdown seconds) while open // the last voice outcome, for the screen-reader live region (the toast shows it too)
  /** "listen": words build the order; "command": a place / send was heard, later words only matter as "stop". */
  const phase = useRef<"listen" | "command">("listen");
  const stopMark = useRef(0); // length of the transcript when the command was heard: only words after it can say "stop"
  const followUntil = useRef(0); // hands-free: until then a bare "place order" / "send to kitchen" needs no wake phrase
  const followNext = useRef(false); // a voice action just finished: the next background listener opens the follow-up window
  const executing = useRef(false); // a spoken place / send is running on the till: hands-free starts again when it is over
  /** The follow-up window counts from when hands-free can hear again (a slow device or a busy till must not eat it). */
  const armFollow = () => { followNext.current = true; followUntil.current = nowMs() + FOLLOW_UP_MS; };
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const taken = useRef<number>(0); // the intent id already being run (an effect re-run never runs it twice)
  const [waitNote, setWaitNote] = useState<string | null>(null); // why auto-listen is on but not listening (yet)
  const [pressed, setPressed] = useState(false); // the mic button visibly "presses" itself when "Hey Zonov" is heard
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (pressTimer.current) clearTimeout(pressTimer.current); }, []);
  const quietRef = useRef(false);

  const armed = useRef(true); // may auto-start (re-armed by a new ticket, Add to order, switching auto-listen on)
  const typing = useRef(false);
  const lastHeard = useRef(0);
  const startedAt = useRef(0);
  const autoSession = useRef(false);
  const cutWake = useRef(false);   // the transcript still contains the wake phrase (the waiting session): only the words after it count
  const starting = useRef(false);
  const spoke = useRef(false); // something was heard in this listening session
  const run = useRef(0); // bumped on close: a late answer from a cancelled request is ignored
  const rec = useRef<{ recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; timer: ReturnType<typeof setInterval>; discard: boolean } | null>(null);
  const live = useRef<{ listener: LiveListener; timer: ReturnType<typeof setInterval> } | null>(null);
  const meta = useRef<LiveMeta>(freshMeta());
  autoRef.current = auto;

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const catName = useMemo(() => new Map(cats.map((c) => [c.id, c.name])), [cats]);
  const grouped = useMemo(() => cats.map((c) => ({ cat: c, items: items.filter((i) => i.category_id === c.id) })).filter((g) => g.items.length), [cats, items]);
  // phrases learnt from staff corrections ON THIS DEVICE (dishLearn.ts) go in after the server's, so they win
  const lessons = useSyncExternalStore(onDishLessons, dishLessons, () => EMPTY_LESSONS);
  const vmenu = useMemo(() => buildVoiceMenu(items, cats, [...(aliases ?? []), ...(lessons.length ? dishLessonAliases(new Set(items.map((i) => i.id))) : [])]), [items, cats, aliases, lessons]);
  // spoken modifiers ("butter kam dalna", "bina pyaaz ke") become the dish's note before parsing (voiceModifiers.ts)
  const modNames = useMemo(() => items.map((i) => i.name.toLowerCase()), [items]);
  const withMods = (t: string) => normalizeModifiers(t, { names: modNames });

  // Leaving the page mid-recording releases the microphone.
  useEffect(() => () => {
    const r = rec.current;
    if (r) { r.discard = true; clearInterval(r.timer); if (r.recorder.state !== "inactive") r.recorder.stop(); r.stream.getTracks().forEach((t) => t.stop()); }
    const l = live.current;
    if (l) { clearInterval(l.timer); l.listener.abort(); }
  }, []);

  // ---- auto-listen: arm on a new ticket / switching on, start when the till is quiet, stop for the safeguards ----
  const canAuto = auto && lang === "en" && online && !disabled && !currentLocked && items.length > 0 && stage === "closed" && !saving;
  const attemptAuto = useRef<() => void>(() => {});
  attemptAuto.current = () => {
    setWaitNote(!auto || lang !== "en" || !armed.current || live.current ? null
      : !online ? "Voice is paused: you are offline"
        : disabled ? null
          : currentLocked ? "Voice is paused: this bill is already billed. Open a new bill to use hands-free"
          : items.length === 0 ? "Voice is paused: the menu is still loading"
            : stage !== "closed" || saving ? null
              : document.hidden ? "Voice is paused while this tab is in the background"
                : anotherDialogOpen() ? "Voice is paused while another window is open"
                    : !speechCtor() ? "This browser cannot listen live. Use Chrome or Edge, or tap the mic to record"
                      : null);
    // NEVER SLEEP (owner, 2026-11-02): a focused search box and the 60 s pause after a speech-service error no longer stop
    // hands-free (only a hidden tab, another app dialog, offline, a busy / billed ticket do, and each resumes by itself)
    if (!canAuto || executing.current || !armed.current || starting.current || live.current || document.hidden || anotherDialogOpen() || !speechCtor()) return;
    starting.current = true;
    void micPermission().then((perm) => {
      starting.current = false;
      // re-check everything: the world may have changed while the permission query ran
      if (!canAuto || executing.current || !armed.current || live.current || document.hidden || anotherDialogOpen()) return;
      if (perm === "denied") { armed.current = false; sleepNote("blocked"); return; }
      // "prompt": auto-listen was switched on on purpose, so let the browser ask for the microphone itself (Allow on every visit
      // then makes later starts silent). A refusal or an ignored prompt comes back through onFail as "tap the mic".
      startLive(false, true);
    });
  };
  // ---- hands-free re-arm (lib/handsFree.ts): after it gave up, focus / a visible tab / back online / a granted permission
  // start it again by itself; a denied permission never does (no loop), and a broken service is limited per 10 minutes ----
  const rearm = useRef<RearmState>({ sleep: null, history: [] });
  // "sleeping" (the speech service kept failing) retries BY ITSELF, without limit, with a growing delay (15 s ... 5 min): a counter
  // screen that never loses focus never got a focus / visible trigger and stayed dead until a reload (owner bug 2026-11-02)
  const sleepTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sleepTries = useRef(0);
  function sleepNote(n: IdleNote) {
    rearm.current = { ...rearm.current, sleep: n }; setIdleNote(n);
    if (sleepTimer.current) { clearTimeout(sleepTimer.current); sleepTimer.current = null; }
    if (n === "sleeping") sleepTimer.current = setTimeout(() => { sleepTimer.current = null; sleepTries.current++; wake.current("timer"); }, sleepDelay(sleepTries.current));
  }
  useEffect(() => () => { if (sleepTimer.current) clearTimeout(sleepTimer.current); }, []);
  const wake = useRef<(t: Trigger) => void>(() => {});
  wake.current = (t: Trigger) => {
    const r = rearmDecision(rearm.current, t, nowMs(), !autoRef.current);
    rearm.current = r.state;
    if (!r.rearm) return;
    armed.current = true; typing.current = false; setIdleNote(null);
    void Promise.resolve().then(() => attemptAuto.current());
  };
  useEffect(() => {
    // a new order: wakes a browser that needed a tap or a sleeping listener, never a denied microphone
    if (rearm.current.sleep) wake.current("new-ticket"); else { armed.current = true; typing.current = false; }
  }, [ticketKey]);
  useEffect(() => { if (auto) wake.current("switch-on"); else { rearm.current = { sleep: null, history: [] }; void Promise.resolve().then(() => setIdleNote(null)); } }, [auto]);
  useEffect(() => {
    const onFocus = () => wake.current("focus");
    const onVisible = () => { if (!document.hidden) wake.current("visible"); };
    const onOnline = () => wake.current("online");
    // a microphone plugged in / out (AirPods, USB): wake a sleeping or "no mic" hands-free (liveSpeech restarts a running one)
    const md = navigator.mediaDevices;
    const onDevice = () => { micLog("event", "device change (a microphone was plugged in or out)"); wake.current("device"); };
    md?.addEventListener?.("devicechange", onDevice);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    let perm: PermissionStatus | null = null;
    const onPerm = () => { micLog("event", `microphone permission: ${perm?.state ?? "?"}`); if (perm?.state === "granted") wake.current("permission-granted"); };
    void navigator.permissions?.query?.({ name: "microphone" as PermissionName }).then((p) => { perm = p; p.addEventListener("change", onPerm); }).catch(() => { /* Safari: no permission events */ });
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      md?.removeEventListener?.("devicechange", onDevice);
      perm?.removeEventListener("change", onPerm);
    };
  }, []);
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => attemptAuto.current(), 700);
    void Promise.resolve().then(() => attemptAuto.current());
    return () => clearInterval(id);
  }, [auto]);
  // switched off, another language, offline or the ticket is locked: stop the background listener
  useEffect(() => {
    if (quietRef.current && (!auto || lang !== "en" || !online || disabled)) { quietStop(auto ? "dialog" : "off"); }
    if (!auto) void Promise.resolve().then(() => setIdleNote(null));
  }, [auto, lang, online, disabled]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onVis = () => {
      micLog("event", `tab ${document.hidden ? "hidden" : "visible"}`);
      if (!document.hidden) return; // coming back: the auto-start check resumes listening by itself
      if (quietRef.current) quietStop("hidden");
      else if (live.current) stopLive(); // the sheet is open: settle what was heard, stop listening
    };
    const onFocusIn = (e: FocusEvent) => {
      const el = e.target as HTMLElement | null;
      void el; // typing no longer pauses hands-free (never sleep)
    };
    const onFocusOut = () => { typing.current = false; };
    const onActivity = () => { lastHeard.current = nowMs(); };
    const watch = setInterval(() => { if (quietRef.current && anotherDialogOpen()) quietStop("dialog"); }, 500);
    document.addEventListener("visibilitychange", onVis);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("pointerdown", onActivity);
    document.addEventListener("keydown", onActivity);
    return () => {
      clearInterval(watch);
      document.removeEventListener("visibilitychange", onVis);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("pointerdown", onActivity);
      document.removeEventListener("keydown", onActivity);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function release() {
    const r = rec.current;
    rec.current = null;
    if (!r) return;
    clearInterval(r.timer);
    r.stream.getTracks().forEach((t) => t.stop());
    micLog("event", "mic stream released");
  }

  function endLive(how: "stop" | "abort") {
    const l = live.current;
    live.current = null;
    if (!l) return;
    clearInterval(l.timer);
    if (how === "stop") l.listener.stop(); else l.listener.abort();
  }

  async function understand(input: { audio: Blob } | { text: string }, source: Source, doneAfter = false) {
    setStage("busy"); setError(null);
    const mine = ++run.current;
    try {
      let r = await api.voiceOrder(input, lang);
      if (mine !== run.current) return;
      // "done" said inside a recording: the server's words are read again without it (so it is never part of a dish, a table or
      // a phrase, whatever the server's parser does with it), and the sheet adds what is clear.
      const dn = splitDone(r.transcript ?? "", doneMenu(vmenu));
      if (dn.done) {
        doneAfter = true;
        if ("audio" in input && dn.rest.trim()) {
          try { const again = await api.voiceOrder({ text: dn.rest }, lang); if (mine !== run.current) return; r = { ...again, transcript: again.transcript ?? dn.rest }; } catch { /* keep the first reading */ }
        }
      }
      r = { ...r, unmatched: r.unmatched.filter((u) => splitDone(u, doneMenu(vmenu)).rest.trim()) };
      const d = toDraft(r, byId, tables, source, lang, vmenu);
      setDraft(d); setPhoneErr(d.phoneHeardBad ? "Check this number: it did not look like a valid phone number" : null);
      setStage("confirm");
      const next = intentFor(d.command, doneAfter);
      if (next) setIntent(next);
    } catch (e) {
      if (mine !== run.current) return;
      setError(e instanceof ApiError ? (e.status === 0 ? "No connection. The AI needs the internet." : e.message) : "Could not understand the order");
      setStage("typing");
      if ("text" in input) setText(input.text);
    }
  }

  // ---- live, on-device path ----
  function liveText(u: LiveUpdate) {
    const combined = u.finalText + (u.interim ? (u.finalText ? ", " : "") + u.interim : "");
    return { combined, pendingFrom: u.interim ? u.finalText.length : Infinity };
  }

  /** Hands-free sessions: only the words AFTER "Hey Zonov" count. null = the phrase is not in the transcript (yet). */
  function cutAfterWake(u: LiveUpdate): LiveUpdate | null {
    const { combined, pendingFrom } = liveText(u);
    let a = afterWake(combined, wakeSensitivity());
    if (a) wakeOffset.current = a.offset;
    // the recogniser REWROTE the wake phrase in a later version of the words ("hey zonov" as an interim, "hey Jonas" final;
    // hostile pass): the other guesses, else the place where the wake phrase was (the order words after it still count)
    if (!a) for (const alt of u.alternatives ?? []) { const w = afterWake(alt, wakeSensitivity(), { otherGuess: true }); if (w) { a = { rest: w.rest, offset: Math.max(0, combined.length - w.rest.length) }; break; } }
    if (!a && wakeOffset.current !== null) { const at = Math.min(wakeOffset.current, combined.length); a = { rest: combined.slice(at).replace(/^[\s,.;:!?-]+/, ""), offset: at + (combined.slice(at).length - combined.slice(at).replace(/^[\s,.;:!?-]+/, "").length) }; }
    if (!a) return null;
    const pf = pendingFrom === Infinity ? Infinity : pendingFrom - a.offset;
    if (pf === Infinity) return noWakes({ finalText: a.rest, interim: "" });
    if (pf <= 0) return noWakes({ finalText: "", interim: a.rest.replace(/^[,\s]+/, "") });
    return noWakes({ finalText: a.rest.slice(0, pf), interim: a.rest.slice(pf).replace(/^[,\s]+/, "") });
  }
  const wakeOffset = useRef<number | null>(null); // where the words after the wake phrase began (this session)
  /** Woken by another guess of the recogniser: the order is that guess's words after the wake phrase plus everything heard since. */
  const altCut = useRef<{ offset: number; rest: string } | null>(null);
  function cutAfterAlt(u: LiveUpdate, a: { offset: number; rest: string }): LiveUpdate {
    const { combined, pendingFrom } = liveText(u);
    const tail = combined.slice(a.offset).replace(/^[,\s]+/, "");
    const fin = pendingFrom === Infinity ? tail : combined.slice(a.offset, Math.max(a.offset, pendingFrom)).replace(/^[,\s]+/, "");
    const interim = pendingFrom === Infinity ? "" : combined.slice(Math.max(a.offset, pendingFrom)).replace(/^[,\s]+/, "");
    return noWakes({ finalText: [a.rest, fin].filter((x) => x.trim()).join(", "), interim });
  }
  /** "Hey Zonov" said again while the sheet is open is no dish (it would stay as an unmatched phrase and hold "done"). */
  const noWakes = (u: LiveUpdate): LiveUpdate => ({ finalText: stripWakes(u.finalText, wakeSensitivity()), interim: stripWakes(u.interim, wakeSensitivity()) });

  /** Parses what was heard so far into the draft; returns a command said at its end (never run before the confirm tap). */
  function onHeard(u: LiveUpdate): SheetCommand | null {
    setHeard(u);
    const { combined, pendingFrom } = liveText(u);
    const cmd = splitCommand(combined, vmenu);
    // the finished words get their modifiers rewritten; words still being heard stay as they are (so pendingFrom still points at them)
    const done = pendingFrom >= cmd.rest.length ? withMods(cmd.rest) : withMods(cmd.rest.slice(0, pendingFrom));
    const restText = pendingFrom >= cmd.rest.length ? done : `${done}${cmd.rest.slice(pendingFrom)}`;
    const parsed = parseOrder(restText, vmenu, { tables, pendingFrom: pendingFrom >= cmd.rest.length ? Infinity : done.length });
    setDraft((prev) => mergeParsed(prev, parsed, meta.current, u.finalText || combined, "live", "en", byId, cmd.command));
    return cmd.command;
  }

  /** Listening ended (Stop, time limit, or the recogniser gave up): settle the transcript and show the sheet. */
  function onLiveEnd(raw: LiveUpdate) {
    const u = altCut.current ? cutAfterAlt(raw, altCut.current) : cutWake.current ? cutAfterWake(raw) ?? { finalText: "", interim: "" } : noWakes(raw);
    onHeard({ finalText: liveText(u).combined, interim: "" });
    setStage((s) => (s === "live" ? "confirm" : s));
    const said = splitCommand(liveText(u).combined, vmenu);
    const nothing = !parseOrder(withMods(said.rest), vmenu, { tables }).lines.length;
    // a done / place / send still unfinished when the recogniser ended (network error, Stop, the hands-free pause) still counts
    const after = intentFor(said.command, said.done);
    if (nothing && said.rest.trim() && online) void aiFromTranscript(said.rest, after);
    else if (after) setIntent(after);
  }

  /**
   * What was heard so far: dishes build the draft; "done" adds; a place / send starts the command (voiceFlow.ts). Acts on a
   * FINISHED result, or on an unfinished guess that stayed the same for a moment (a recogniser may keep the last words as an
   * interim until the session ends); "bas" / "thanks" and the recogniser's slips of "done" only on a finished result.
   */
  function decide(cut: LiveUpdate, settled: boolean) {
    if (settleTimer.current) { clearTimeout(settleTimer.current); settleTimer.current = null; }
    const text = liveText(cut).combined;
    const said = splitCommand(text, vmenu);
    const unfinished = !!cut.interim && !settled;
    if (!said.command && !said.done) { onHeard(cut); return; }
    if (unfinished) {
      onHeard(cut);
      if (said.command || !splitDone(text, doneMenu(vmenu)).weak) {
        const mine = run.current;
        settleTimer.current = setTimeout(() => { settleTimer.current = null; if (mine === run.current && phase.current === "listen" && live.current) decide(cut, true); }, SETTLE_MS);
      }
      return;
    }
    if (said.command && said.command !== "clear") {
      // the order is settled: the same recogniser keeps listening, but only for "stop" during the countdown
      onHeard({ finalText: text, interim: "" });
      phase.current = "command"; stopMark.current = text.length; commandText.current = text;
      setStage("confirm"); setIntent(intentFor(said.command, said.done));
      return;
    }
    endLive("abort");
    onHeard({ finalText: said.command ? text : said.rest, interim: "" });
    setStage("confirm"); setIntent(intentFor(said.command, said.done));
  }

  /** Nothing matched on the device: let the AI read the transcript as TEXT (much faster than audio). */
  async function aiFromTranscript(t: string, after: Intent | null = null) {
    const mine = run.current;
    setImproving(true);
    try {
      const r = await api.voiceOrder({ text: t.slice(0, 2000) }, lang);
      if (mine !== run.current) return;
      const d = toDraft(r, byId, tables, "ai-live", lang, vmenu);
      setDraft((prev) => (prev && prev.lines.length ? prev : { ...d, transcript: prev?.transcript ?? t }));
      const next = after ?? intentFor(d.command, false);
      if (next) setIntent(next);
    } catch (e) {
      if (mine === run.current) toast.error(e instanceof ApiError ? e.message : "The AI could not read it");
    } finally { if (mine === run.current) setImproving(false); }
  }

  // Auto-learn (wakeWord.ts, on this device only, text only, never sent): a near miss heard while waiting ("hey zanob") is
  // learned when a voice command then succeeds; the toast says so, Voice settings lists it (delete / reset / switch off).
  const quietFinal = useRef("");
  // ---- Never sleep, step 2: the mic guard (one persistent stream, voice activity, the gap fallback; lib/micGuard.ts) ----
  const guard = useRef<MicGuard | null>(null);
  const gapClips = useRef<number[]>([]);
  const gapOff = useRef(false); // the fallback answered 403: off for this page session
  // ---- the OFFLINE wake detector (lib/wakeDetector.ts): Vosk on the guard's stream decides the wake, not the cloud recogniser ----
  const [detector, setDetector] = useState<{ state: WakeDetector["state"]; note?: string }>({ state: "off" });
  const forceGap = useRef(0); // until then the next utterance the server transcribes is the order after a detector wake
  const srAliveRef = useRef(false);
  srAliveRef.current = srAlive;
  /** "Hey Zonov" from the offline detector: open the order like the wake phrase; the order words come from Web Speech if it is
   *  really listening, else from the server speech-to-text of the utterance (the pre-roll holds the words said right after). */
  function detectorWake(d: Detection) {
    if (!quietRef.current) { micLog("event", "detector wake ignored: not waiting (the sheet is open)"); return; }
    const l = live.current?.listener;
    if (l && srAliveRef.current) {
      const { combined, pendingFrom } = liveText(l.text);
      altCut.current = { offset: pendingFrom === Infinity ? combined.length : pendingFrom, rest: "" };
      quietRef.current = false; setQuiet(false); l.forget = false; cutWake.current = false;
      setWoke(true); setStage("live"); setSecs(0); startedAt.current = nowMs(); lastHeard.current = nowMs(); spoke.current = false;
      setPressed(true); if (pressTimer.current) clearTimeout(pressTimer.current); pressTimer.current = setTimeout(() => setPressed(false), 700);
      micLog("event", `detector wake (“${d.text}”): the order comes from Web Speech`);
      return;
    }
    forceGap.current = Date.now() + 15_000;
    micLog("event", `detector wake (“${d.text}”): Web Speech is not listening, the utterance goes to the server speech-to-text`);
  }
  const [speechNow, setSpeechNow] = useState(false); // the detector hears speech right now (the mic chip reacts at once)
  function onUtterance(u: Utterance) {
    // give the recogniser 1.5 s after the speech ended; only what it produced NOTHING for goes to the server's speech-to-text
    setTimeout(() => {
      const l = live.current?.listener;
      if (gapOff.current) { micLog("event", "gap check skipped: fallback unavailable this session"); return; }
      const forced = forceGap.current > Date.now();
      // the order sheet is open (Web Speech or a tap is capturing the order): no server transcription of the same words
      if (!quietRef.current && !forced) return;
      const d = forced ? { send: u.end - u.start >= 300, why: "the offline detector heard Hey Zonov" } : gapDecision(u, { lastResultAt: l?.finalAt ?? 0, now: Date.now(), recent: gapClips.current });
      micLog("event", `gap check (${u.end - u.start} ms of speech): ${d.send ? "SEND to speech-to-text" : `no: ${d.why}`}`);
      if (!d.send || !u.clip || !online) return;
      gapClips.current = [...gapClips.current.filter((t) => Date.now() - t < 600_000), Date.now()];
      const t0 = Date.now();
      api.voiceOrder({ audio: u.clip }, "en").then((r) => {
        const text = (r.transcript ?? "").trim();
        micLog("final", `final (gap, server speech-to-text, ${Date.now() - t0} ms): “${text}”`);
        if (text) latest.current.gap(text, forced);
      }).catch((e) => {
        // 403 (feature_not_entitled): the plan has no AI; say it ONCE and stop calling for this session (never silently)
        if (e instanceof ApiError && e.status === 403) { gapOff.current = true; micLog("error", "fallback unavailable: plan does not include AI (speech-to-text off for this session)"); return; }
        micLog("error", `gap speech-to-text failed (${e instanceof ApiError ? e.status : "error"})`);
      });
    }, 1300);
  }
  /** Words the recogniser missed (heard by the server): the same wake / Direct-mode pipeline, once. */
  function handleGapText(text: string, forced = false) {
    const l = live.current?.listener;
    if (!l || !quietRef.current) { micLog("event", "gap text ignored: not waiting for the wake phrase"); return; }
    if (forced) forceGap.current = 0;
    // after a detector wake the server's words ARE the order: "Hey Zonov" itself, however it was written, is dropped
    const w = afterWake(text, wakeSensitivity()) ?? (forced ? { rest: dropWakeWords(text), offset: 0 } : null);
    micLog(w ? "wake" : "nowake", `${explainWake(text, wakeSensitivity())} (gap)`);
    if (!w) { direct(text); return; }
    const base = liveText(l.text).combined.length;
    altCut.current = { offset: base, rest: w.rest };
    quietRef.current = false; setQuiet(false); l.forget = false; cutWake.current = false;
    setWoke(true); setStage("live"); setSecs(0); startedAt.current = nowMs(); lastHeard.current = nowMs(); spoke.current = !!w.rest.trim();
    decide(cutAfterAlt(l.text, altCut.current), true);
  }
  // the guard runs while hands-free is on, the tab is visible and the microphone is allowed (never prompts by itself)
  useEffect(() => {
    if (!auto) return;
    let stopped = false;
    const det = new WakeDetector({ onWake: (d) => latest.current.detectorWake(d), sensitivity: wakeSensitivity, onState: (state, note) => setDetector({ state, note }) });
    const g = new MicGuard({ onSpeech: setSpeechNow, onUtterance: (u) => latest.current.utterance(u),
      onGraph: (ctx, src) => { if (detectorOn()) void det.start(ctx, src); }, onRelease: () => det.stop() });
    guard.current = g;
    const run = () => { if (stopped || document.hidden) return; void micPermission().then((p) => { if (!stopped && p === "granted" && !document.hidden) void g.start(); }); };
    const onVis = () => { if (document.hidden) g.stop(); else run(); };
    run();
    document.addEventListener("visibilitychange", onVis);
    // test hook: an utterance as the detector would report it (the harness has no real audio)
    (window as unknown as { __micGuardUtterance?: (ms: number) => void }).__micGuardUtterance = (ms: number) => { const end = Date.now(); latest.current.utterance({ start: end - ms, end, clip: new Blob(["x"], { type: "audio/webm" }) }); };
    return () => { stopped = true; document.removeEventListener("visibilitychange", onVis); g.stop(); guard.current = null; };
  }, [auto]);

  // ---- Direct mode (owner 2026-11-02, testing phase): dishes into the selected draft bill without "Hey Zonov" ----
  const directSeen = useRef(0); // how much of the waiting session's final text was looked at
  const directTimes = useRef<number[]>([]);
  const lastDirect = useRef<{ id: string; lines: VoiceApply["lines"]; label: string } | null>(null);
  const activeDraftBill = () => bills.find((b) => b.id === ticketKey);
  const activeDraft = (() => { const b = activeDraftBill(); return !!b && !b.placed && !b.locked && !currentLocked; })();
  const directActive = auto && directOn() && activeDraft;
  /** One finished phrase heard while waiting, in Direct mode: add / command / undo / ignore (never a line from chatter). */
  function direct(seg: string): "command" | null {
    if (!directOn() || !activeDraft || !seg.trim()) return null;
    const d = directDecision(seg, vmenu, { tables, names: modNames, billHasLines: (activeDraftBill()?.itemCount ?? 0) > 0 });
    if (d.kind === "ignore") { micLog("event", `direct: ignored “${seg.slice(0, 60)}” (${d.why})`); return null; }
    if (d.kind === "command") { micLog("event", `direct: ${d.command} without the wake phrase`); return "command"; }
    if (d.kind === "undo") {
      const u = lastDirect.current;
      lastDirect.current = null;
      if (u && onUndoApply) { onUndoApply(u.id, u.lines); toast.message(`Undone: ${u.label}`); micLog("event", "direct: undo"); }
      return null;
    }
    const now = nowMs();
    if (!rateOk(directTimes.current, now)) { micLog("event", "direct: ignored (too many adds in a moment)"); return null; }
    // the target: "bill 2 me ...", "table 4 me ..." (an open bill only, never created), else the selected bill
    let bill: number | null = null;
    if (d.billNo !== null) {
      const b = bills.find((x) => x.no === d.billNo);
      if (!b || b.locked) { toast.message(`Bill ${d.billNo} is not open`, { description: "Nothing was added. Open it first, or say the dishes for the selected bill." }); return null; }
      bill = b.no;
    } else if (d.table) {
      const b = bills.find((x) => x.tableId === d.table!.id && !x.locked);
      if (!b) { toast.message(`No open order on table ${d.table.label}`, { description: "Nothing was added." }); return null; }
      bill = b.no;
    }
    const vetoed = d.lines.filter((l) => vegHidden(l.itemId)).map((l) => byId.get(l.itemId)).filter((x): x is MenuItem => !!x);
    const lines = d.lines.flatMap((l) => {
      const item = byId.get(l.itemId);
      if (!item || isSoldOut?.(item) || vegHidden(l.itemId)) return [];
      const size = lineSize(item, l.variantId, l.defaulted);
      return [{ item, variantId: size.variantId, qty: l.qty, note: l.note ? l.note.charAt(0).toUpperCase() + l.note.slice(1) : null, ...(l.issues.length ? { check: true } : {}) }];
    });
    if (vetoed.length) {
      // Veg only is on: never added silently; "Add anyway" adds it once (the filter stays on)
      const veto = d.lines.filter((l) => vegHidden(l.itemId));
      toast.warning(`${vetoed.map((x) => x.name).join(", ")} ${vetoed.length === 1 ? "is" : "are"} non-veg and Veg only is on`, { duration: 10_000,
        action: { label: "Add anyway", onClick: () => void Promise.resolve(onApply({ customer: null, type: null, tableId: null, bill,
          lines: veto.flatMap((l) => { const item = byId.get(l.itemId); return item ? [{ item, variantId: lineSize(item, l.variantId, l.defaulted).variantId, qty: l.qty, note: l.note }] : []; }) })) } });
      micLog("event", `direct: not added (Veg only): ${vetoed.map((x) => x.name).join(", ")}`);
    }
    if (!lines.length) { micLog("event", "direct: ignored (sold out or Veg only)"); return null; }
    directTimes.current = [...directTimes.current.filter((t) => now - t < 2000), now];
    void Promise.resolve(onApply({ lines, customer: null, type: null, tableId: null, bill })).then((id) => {
      if (!id) return;
      const label = lines.map((l) => `${l.item.name} ×${l.qty}`).join(", ");
      const no = bill ?? activeDraftBill()?.no;
      lastDirect.current = { id, lines, label };
      micLog("event", `direct: added to Bill ${no}: ${label}`);
      toast.success(`Added to Bill ${no}: ${label}`, { duration: 6000, action: onUndoApply ? { label: "Undo", onClick: () => { onUndoApply(id, lines); lastDirect.current = null; } } : undefined });
    });
    return null;
  }
  const commandText = useRef(""); // the phrase that carried the last spoken place / send (testing-phase sharing only)
  // Testing phase: the server says whether samples may be shared (GET /voice/wake-config), at start and every 6 h
  useEffect(() => {
    setShareTransport({
      get: () => apiRequest<{ share_samples?: unknown; variants?: unknown }>("/voice/wake-config"),
      post: (body) => apiRequest<void>("/voice/wake-samples", { method: "POST", body: JSON.stringify(body) }),
    });
    void refreshWakeConfig();
    const id = setInterval(() => void refreshWakeConfig(), SHARE_CONFIG_EVERY_MS);
    return () => clearInterval(id);
  }, []);
  function learnFromSuccess() {
    const w = confirmNearMiss();
    if (w) toast.message(`Learned how you say “Hey Zonov” (“hey ${w}”)`, { description: "On this device only. Voice settings lists it; delete it there." });
  }

  /**
   * "Mic not working? Reset": tears EVERYTHING down without a reload (the recogniser, a recording stream, the retry timers, the
   * 60 s pause after a speech-service error, stuck "starting" / "typing" flags) and starts listening again (QA B14).
   */
  function resetMic() {
    micLog("event", "Reset pressed");
    guard.current?.stop();
    void Promise.resolve().then(() => { if (autoRef.current && guard.current) void guard.current.start(); });
    close();
    release();
    if (sleepTimer.current) { clearTimeout(sleepTimer.current); sleepTimer.current = null; }
    sleepTries.current = 0; starting.current = false; typing.current = false; executing.current = false;
    resetSpeechBroken(); setTrouble(null); setMicNote(null);
    wake.current("reset");
    toast.message("Microphone reset", { description: autoRef.current ? "Hands-free listens for “Hey Zonov” again." : "Tap the mic to speak an order." });
  }

  // ---- the live listener's handlers, re-created every render and reached through `latest` (never a stale closure) ----
  function listenerUpdate(u: LiveUpdate, mine: number, listener: LiveListener) {
      if (mine !== run.current) return;
      if (quietRef.current) {
        // Waiting: whatever is said is looked at ONLY for the wake phrase. Nothing before it is parsed, shown, stored or sent.
        const heardNow = liveText(u).combined;
        noteWakeHeard(heardNow); // Voice settings shows what the recogniser last returned (memory only)
        let wake = afterWake(heardNow, wakeSensitivity());
        // the recogniser's OTHER guesses for the newest words (maxAlternatives 5): "hey zonov" may be the 2nd guess (QA B18)
        if (!wake) for (const alt of u.alternatives ?? []) {
          const a = afterWake(alt, wakeSensitivity(), { otherGuess: true });
          if (a) { wake = a; altCut.current = { offset: heardNow.length, rest: a.rest }; micLog("wake", `${explainWake(alt, wakeSensitivity())} in another guess`); break; }
        }
        if (wake || !u.interim) micLog(wake ? "wake" : "nowake", explainWake(heardNow, wakeSensitivity())); // the mic debug box
        if (!u.interim && u.finalText !== quietFinal.current) {
          quietFinal.current = u.finalText;
          if (!wake) noteNearMiss(u.finalText);
          // testing phase only, server-switched (voiceShare.ts): the last words of the wait, text only, digits removed
          if (wake || /\b(hey|hay|hi|he|hai|ok|okay|a|e)\b/i.test(u.finalText)) shareSample(u.finalText.slice(-120), !!wake, "wake");
        }
        // just after a voice action, a bare "place order" / "send to kitchen" (the whole utterance, finished) needs no wake phrase
        const follow = !wake && followUntil.current > nowMs() && !u.interim ? detectCommand(stripWakes(heardNow), vmenu) : null;
        let followUp = !!follow?.command && follow.command !== "clear" && !follow.rest.trim();
        // Direct mode: a finished phrase without the wake phrase, in a draft bill: dishes go straight in (voiceDirect.ts)
        if (!wake && !followUp && !u.interim && u.finalText.length > directSeen.current) {
          const segStart = directSeen.current;
          const seg = u.finalText.slice(segStart).replace(/^[,\s]+/, "");
          directSeen.current = u.finalText.length;
          // a place / send in Direct mode: only that phrase counts (the dishes before it are in the bill already)
          if (direct(seg) === "command") { followUp = true; altCut.current = { offset: segStart, rest: "" }; }
        }
        if (!wake && !followUp) return;
        if (followUp) cutWake.current = false;
        if (altCut.current) cutWake.current = false;
        setPressed(true); if (pressTimer.current) clearTimeout(pressTimer.current); pressTimer.current = setTimeout(() => setPressed(false), 700);
        // "Hey Zonov" acts like a tap on the mic, but the SAME recogniser keeps listening: Chrome may refuse a new one started
        // without a tap right after the old one was aborted. From here on only the words after the phrase count.
        quietRef.current = false; setQuiet(false); listener.forget = false;
        setWoke(true); setStage("live"); setSecs(0);
        startedAt.current = nowMs(); lastHeard.current = nowMs(); spoke.current = followUp || !!wake?.rest.trim();
      }
      lastHeard.current = nowMs();
      const cut = altCut.current ? cutAfterAlt(u, altCut.current) : cutWake.current ? cutAfterWake(u) : noWakes(u);
      if (!cut) return;
      if (phase.current === "command") {
        // a place / send was heard: the order is settled; only "stop" / "cancel" / "ruko" / "nahi" said after it matter now
        if (saysStop(liveText(cut).combined.slice(stopMark.current))) cancelCountdown("said");
        return;
      }
      if (cut.finalText || cut.interim) spoke.current = true;
      decide(cut, false);
    
  }
  function listenerFail(why: LiveFailure, mine: number) {
      if (mine !== run.current) return;
      endLive("abort");
      if (quietRef.current) { // auto-start was refused (no gesture / no permission) or the service kept failing: never fall back to recording
        quietRef.current = false; setQuiet(false); armed.current = false;
        // "not-allowed" without a tap is how iOS-like browsers refuse a start: that needs a tap, not a settings change.
        // A really denied microphone is known from the permission query before starting (attemptAuto -> "blocked").
        // NEVER SLEEP: unless the browser really denies the microphone, try again by itself (1 s, then every 3 s)
        void micPermission().then((p) => sleepNote(p === "denied" ? "blocked" : why === "no-mic" ? "nomic" : p === "granted" || why === "sleeping" ? "sleeping" : "tap"));
        return;
      }
      if (why === "blocked") { setMicNote("Microphone access is blocked. Allow it in the browser's site settings, or type the order."); setStage("typing"); }
      else if (why === "no-mic") { setMicNote("No microphone found. Type the order instead."); setStage("typing"); }
      else if (online) void startRecording(); // this browser's recogniser is not usable: record for the AI instead
      else { setMicNote("Speech recognition is not available offline on this device. Type the order instead."); setStage("typing"); }
    
  }
  function listenerEnd(u: LiveUpdate, mine: number) {
      if (mine !== run.current) return;
      endLive("abort");
      if (phase.current === "command") return; // the countdown goes on (a tap still cancels it)
      if (quietRef.current) { quietRef.current = false; setQuiet(false); armed.current = true; return; } // the wait ended abnormally: start it again
      onLiveEnd(u);
    
  }
  function listenerTick() {
    const now = nowMs();
    if (!quietRef.current) setSecs(Math.min(Math.floor((now - startedAt.current) / 1000), MAX_LIVE_SECONDS));
    if (phase.current !== "listen") return; // a place / send was heard: no silence settle, no time limit while its countdown runs
    if (autoSession.current && !quietRef.current && now - lastHeard.current > silenceMs()) { silenceStop(); return; } // never while merely waiting for the wake phrase
    if (!quietRef.current && (now - startedAt.current) / 1000 >= MAX_LIVE_SECONDS) stopLive();
  }
  const latest = useRef({ update: listenerUpdate, fail: listenerFail, end: listenerEnd, tick: listenerTick, utterance: onUtterance, gap: handleGapText, detectorWake });
  latest.current = { update: listenerUpdate, fail: listenerFail, end: listenerEnd, tick: listenerTick, utterance: onUtterance, gap: handleGapText, detectorWake };

  function startLive(processLocally: boolean, quietStart = false) {
    if (live.current) endLive("abort"); // one recogniser at a time, always
    meta.current = freshMeta();
    phase.current = "listen"; if (settleTimer.current) { clearTimeout(settleTimer.current); settleTimer.current = null; }
    altCut.current = null; directSeen.current = 0; wakeOffset.current = null;
    setError(null); setDraft(null); setSecs(0); setMicNote(null); setHeard({ finalText: "", interim: "" }); setPhoneErr(null); setIdleNote(null); setDoneHeld(null);
    const mine = ++run.current;
    autoSession.current = quietStart; cutWake.current = quietStart;
    if (quietStart && followNext.current) { followNext.current = false; followUntil.current = nowMs() + FOLLOW_UP_MS; }
    quietRef.current = quietStart; setQuiet(quietStart); setWoke(false); setTrouble(null);
    lastHeard.current = nowMs(); startedAt.current = nowMs(); spoke.current = false;
    const listener = new LiveListener({
      lang: "en-IN", processLocally, persistent: quietStart,
      onTrouble: (code) => { if (mine === run.current) { setTrouble(code); if (code === null) sleepTries.current = 0; } },
      onAlive: (a) => { if (mine === run.current) setSrAlive(a); },
      // the CURRENT render's handlers, every time (a long hands-free session must never run on a stale menu, bills or
      // settings captured when it started; QA B18 "works after a reload, degrades later")
      onUpdate: (u) => latest.current.update(u, mine, listener),
      onFail: (why) => latest.current.fail(why, mine),
      onEnd: (u) => latest.current.end(u, mine),
    });
    const timer = setInterval(() => latest.current.tick(), 250);
    listener.forget = quietStart; // while waiting, finished recogniser sessions are dropped, not accumulated
    live.current = { listener, timer };
    if (!quietStart) setStage("live");
    listener.start(); // a recogniser that cannot start reports through onFail (-> recording / typing, or "tap to start" for auto)
  }

  function stopLive() {
    const l = live.current;
    if (!l) return;
    clearInterval(l.timer);
    quietRef.current = false; setQuiet(false);
    setStage("confirm");
    l.listener.stop(); // the last words arrive, then onEnd settles the draft
  }

  /** The order after "Hey Zonov" went quiet: settle the sheet (nothing is added), or go back to waiting if nothing was said after the wake phrase. */
  function silenceStop() {
    if (quietRef.current) return;
    if (!spoke.current) { close(); return; }
    stopLive();
  }

  /** Ends background auto-listening. `silence` waits for a tap; the others resume by themselves when the cause is gone. */
  function quietStop(why: "hidden" | "dialog" | "typing" | "off") {
    run.current++;
    endLive("abort");
    quietRef.current = false; setQuiet(false);
    if (why === "typing") typing.current = true;
  }

  // ---- recording path (other languages, or no live recogniser) ----
  async function startRecording() {
    setError(null); setDraft(null); setSecs(0); setMicNote(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setMicNote("This browser cannot record audio here. Type the order instead.");
      setStage("typing");
      return;
    }
    setStage("starting");
    const mine = run.current;
    let stream: MediaStream;
    try {
      stream = await getUserMediaQueued({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      if (mine !== run.current) return;
      const blocked = e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError");
      setMicNote(blocked ? "Microphone access is blocked. Allow it in the browser's site settings, or type the order." : "No microphone found. Type the order instead.");
      setStage("typing");
      return;
    }
    // closed (Cancel, Escape, Reset) while the browser was still opening the microphone: release it at once. Before, the stream was
    // kept and Chrome held the microphone, so speech recognition failed ("audio-capture") until a reload (QA B14)
    if (mine !== run.current) { stream.getTracks().forEach((t) => t.stop()); micLog("event", "mic stream released (closed while opening)"); return; }
    const mime = pickMime();
    let recorder: MediaRecorder;
    try { recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined); }
    catch { stream.getTracks().forEach((t) => t.stop()); setMicNote("This browser cannot record audio here. Type the order instead."); setStage("typing"); return; }
    const started = nowMs();
    const state = {
      recorder, stream, chunks: [] as Blob[], discard: false,
      timer: setInterval(() => {
        const s = Math.floor((nowMs() - started) / 1000);
        setSecs(Math.min(s, MAX_RECORD_SECONDS));
        if (s >= MAX_RECORD_SECONDS) stop();
      }, 250),
    };
    rec.current = state;
    recorder.ondataavailable = (ev) => { if (ev.data.size) state.chunks.push(ev.data); };
    recorder.onstop = () => {
      if (state.discard) return;
      const blob = new Blob(state.chunks, { type: (recorder.mimeType || mime || "audio/webm") });
      if (blob.size === 0) { setMicNote("Nothing was recorded. Try again or type the order."); setStage("typing"); return; }
      void understand({ audio: blob }, "ai-audio");
    };
    recorder.start(250);
    setStage("recording");
  }

  /** The mic tap. English + a usable recogniser = live; must start inside this handler (Safari needs the gesture). */
  function start() {
    // a tap on the mic is often a wake that did not work: share what the wait heard just before it (testing phase, text only)
    if (quietRef.current) shareSample(lastWakeHeard().slice(-120), false, "wake");
    if (live.current && quietRef.current) endLive("abort"); // a tap while waiting: drop what the wait heard and start a fresh, tapped session
    rearm.current = { sleep: null, history: [] };
    setIdleNote(null);
    if (lang === "en" && liveSpeechUsable()) {
      if (online) { startLive(false); return; }
      void canRecogniseOffline("en-IN").then((ok) => {
        setOnDevice(ok);
        if (ok) startLive(true);
        else toast.message("Voice ordering needs an internet connection", { description: "This device has no offline speech model for English." });
      });
      return;
    }
    if (!online) { toast.message("Voice ordering needs an internet connection"); return; }
    void startRecording();
  }

  function stop() {
    const r = rec.current;
    if (!r) return;
    release();
    if (r.recorder.state !== "inactive") r.recorder.stop();
  }

  function cancelRecording() {
    const r = rec.current;
    if (r) { r.discard = true; release(); if (r.recorder.state !== "inactive") r.recorder.stop(); }
  }

  /** `rearm`: after Add to order, auto-listen may start again for the next order. */
  function close(rearm = false) {
    run.current++;
    phase.current = "listen"; if (settleTimer.current) { clearTimeout(settleTimer.current); settleTimer.current = null; }
    setCountdown(null); setIntent(null); altCut.current = null;
    cancelRecording();
    endLive("abort");
    quietRef.current = false; setQuiet(false); autoSession.current = false; cutWake.current = false; setWoke(false);
    if (autoRef.current) { armed.current = true; typing.current = false; } // hands-free: Add to order and Cancel both go back to waiting for "Hey Zonov"
    setStage("closed"); setDraft(null); setError(null); setText(""); setPhoneErr(null); setImproving(false); setDoneHeld(null);
    setHeard({ finalText: "", interim: "" });
    if (rearm) { armed.current = true; typing.current = false; setIdleNote(null); }
  }

  function typeInstead() {
    const said = liveText(heard).combined;
    cancelRecording();
    endLive("abort");
    run.current++;
    if (said && !text) setText(said);
    setStage("typing");
  }

  /** Typed order: on-device first; the AI only when no dish matched. */
  function understandTyped() {
    const t = text.trim();
    if (!t) return;
    const cmd = splitCommand(t, vmenu);
    const parsed = parseOrder(withMods(cmd.rest), vmenu, { tables });
    if (parsed.lines.length || cmd.command === "clear") {
      meta.current = freshMeta();
      const d = mergeParsed(null, parsed, meta.current, t, "typed", lang, byId, cmd.command);
      setDraft(d); setError(null);
      setPhoneErr(d.phoneHeardBad ? "Check this number: it did not look like a valid phone number" : null);
      setStage("confirm");
      const next = intentFor(cmd.command, cmd.done);
      if (next) setIntent(next);
      return;
    }
    if (cmd.done && !cmd.rest.trim()) { close(); toast.message("Nothing to add yet", { description: "Type the dishes, then say or type done." }); return; }
    if (!online) { setError("Nothing on the menu matched, and the AI needs the internet. Check the spelling or add the dishes from the menu."); return; }
    void understand({ text: cmd.done ? splitDone(t, doneMenu(vmenu)).rest : t }, "ai-text", cmd.done);
  }

  /** Unmatched phrases -> the AI (as text). Its lines join the draft; nothing else on the sheet changes. */
  async function improveWithAi() {
    const d = draft;
    if (!d || !d.unmatched.length) return;
    const mine = run.current;
    const asked = d.unmatched;
    setImproving(true);
    try {
      const r = await api.voiceOrder({ text: asked.map((u) => u.text).join(", ").slice(0, 2000) }, lang);
      if (mine !== run.current) return;
      const got = toDraft(r, byId, tables, d.source, lang, vmenu);
      for (const u of asked) meta.current.dropped.add(u.key);
      setDraft((prev) => prev && {
        ...prev,
        lines: [...prev.lines, ...got.lines],
        unmatched: [...prev.unmatched.filter((u) => !asked.some((a) => a.key === u.key)), ...got.unmatched],
        name: prev.name || got.name, phone: prev.phone || got.phone,
        type: prev.type ?? got.type, useType: prev.type ? prev.useType : got.useType,
        tableId: prev.tableId ?? got.tableId, tableLabel: prev.tableLabel ?? got.tableLabel, useTable: prev.tableId ? prev.useTable : got.useTable,
        aiImproved: prev.aiImproved + asked.length,
      });
      if (!got.lines.length) toast.message("The AI did not find these on the menu either", { description: "Pick the dishes yourself or drop the phrases." });
    } catch (e) {
      if (mine === run.current) toast.error(e instanceof ApiError ? (e.status === 0 ? "No connection. The AI needs the internet." : e.message) : "The AI could not read it");
    } finally { if (mine === run.current) setImproving(false); }
  }

  const patchLine = (key: string, f: (l: DraftLine) => DraftLine | null) => {
    meta.current.touched.add(key);
    // a merged line (the same dish said twice): its other words are settled into it, so they never come back as a second line
    for (const k of draft?.lines.find((l) => l.key === key)?.mergedKeys ?? []) meta.current.dropped.add(k);
    setDraft((d) => d && { ...d, lines: d.lines.flatMap((l) => { if (l.key !== key) return [l]; const n = f(l); if (!n) meta.current.dropped.add(key); return n ? [n] : []; }) });
  };

  function pickForUnmatched(key: string, itemId: string) {
    const it = byId.get(itemId);
    if (!it) return;
    meta.current.dropped.add(key);
    setDraft((d) => {
      if (!d) return d;
      const u = d.unmatched.find((x) => x.key === key);
      return { ...d, unmatched: d.unmatched.filter((x) => x.key !== key),
        lines: [...d.lines, { key: nextKey(), itemId, variantId: null, qty: 1, note: null, heard: u?.text ?? "", issues: [], phrase: u?.phrase, learn: true }] };
    });
  }

  /**
   * Teaches the till the dishes staff chose themselves, once the order is really added: a pick that was dropped again, or a
   * sheet that was cancelled, teaches nothing. The server keeps them for every till; offline they are simply not learnt.
   */
  function teach(lines: DraftLine[]) {
    const lessons = new Map<string, DraftLine>(); // the same phrase twice: the last choice wins
    for (const l of lines) {
      if (l.learnt && !l.learn && l.phrase) touchDish(l.phrase); // a lesson used again stays for another 60 days
      const phrase = l.learn && l.remember !== false ? l.phrase ?? aliasPhrase(l.heard, vmenu) : "";
      if (phrase && phrase.length <= 200) lessons.set(phrase, l);
    }
    // on this device first (works offline, used from the next order on), then the server copy for every till
    for (const [phrase, l] of lessons) learnDish(phrase, l.itemId, l.variantId);
    if (!online) return;
    for (const [phrase, l] of lessons) {
      void api.learnVoiceAlias({ phrase, menu_item_id: l.itemId, variant_id: l.variantId }).then((a) => onLearnt?.(a)).catch(() => { /* a lesson is never worth an error */ });
    }
  }

  // ---- which bill the lines go to ----
  const activeBill = bills.find((b) => b.id === ticketKey);
  type Target = { kind: "current" | "new" | "no"; no: number; bill?: VoiceBill; valid: boolean; isNew: boolean };
  function targetOf(d: Draft): Target {
    if (d.bill === "new") return { kind: "new", no: nextNo, valid: true, isNew: true };
    if (d.bill.startsWith("no:")) {
      const no = Number(d.bill.slice(3)), bill = bills.find((b) => b.no === no);
      return { kind: "no", no, bill, valid: !bill?.locked, isNew: !bill };
    }
    if (currentLocked || !activeBill) return { kind: "new", no: nextNo, valid: true, isNew: true }; // the active bill cannot take items: a new bill
    return { kind: "current", no: activeBill.no, bill: activeBill, valid: true, isNew: false };
  }
  const targetText = (t: Target) => `Bill ${t.no} ${t.isNew ? "(new)" : t.bill?.locked ? "(already billed)" : t.bill?.placed ? "(new items)" : `(open, ${t.bill?.itemCount ?? 0} ${t.bill?.itemCount === 1 ? "item" : "items"})`}`;
  const target = draft ? targetOf(draft) : null;
  /** The target is already placed: only dishes (and a customer) apply; its order type and table cannot change any more. */
  const placedTarget = !!target?.bill?.placed;
  const ticketLabel = target ? `Bill ${target.no}` : "the bill";
  function setDraftBill(v: string) { meta.current.bill = true; setDraft((d) => d && { ...d, bill: v }); }

  /** Staff change the order type on the sheet: the table must still belong to that kind (inside / outside). */
  function setDraftType(v: string) {
    meta.current.type = true; meta.current.table = true;
    setDraft((d) => {
      if (!d) return d;
      if (!v) return { ...d, useType: false, useTable: false };
      const type = v as OrderType;
      const keep = type === "indoor" || type === "outdoor" ? tables.find((t) => t.id === d.tableId && t.area === type) : undefined;
      return { ...d, type, useType: true, tableId: keep?.id ?? null, tableLabel: keep?.label ?? (type === d.type ? d.tableLabel : null), useTable: !!keep };
    });
  }
  /** A table chosen on the sheet also decides the type (inside / outside follows the table's area). */
  function setDraftTable(id: string) {
    meta.current.type = true; meta.current.table = true;
    setDraft((d) => {
      if (!d) return d;
      const t = tables.find((x) => x.id === id);
      return t ? { ...d, tableId: t.id, tableLabel: t.label, useTable: true, type: t.area, useType: true, tableMode: null } : { ...d, tableId: null, useTable: false, tableMode: null };
    });
  }

  /** A table that already has an order (live table states), unless the lines go to that very order. */
  const busyOf = (tableId: string | null): TableStatus | null => {
    if (!tableId) return null;
    const st = tableStatus?.get(tableId);
    return st && st.status !== "free" && st.status !== "reserved" && st.orders.length ? st : null;
  };
  const soldOutId = (id: string) => { const it = byId.get(id); return !!it && !!isSoldOut?.(it); };
  /** A line voice must not add: sold out, or hidden by Veg only (until "Add anyway"). */
  const lineOut = (l: { itemId: string; anyway?: boolean }) => soldOutId(l.itemId) || (vegHidden(l.itemId) && !l.anyway);
  const withVeto = <L extends { itemId: string; anyway?: boolean }>(ls: L[]) => ls.map((l) => (vegHidden(l.itemId) && !l.anyway ? { ...l, veto: "veg" as const } : l));
  /** The sheet as "done" sees it (voiceSheet.ts doneVerdict): what is still to choose, where the dishes would go. */
  const doneState = (d: Draft): DoneState => {
    const tgt = targetOf(d);
    const wantsTable = d.useType && (d.type === "indoor" || d.type === "outdoor");
    const busy = !tgt.bill?.placed && d.useType && d.useTable ? busyOf(d.tableId) : null;
    return {
      lines: d.lines.map((l) => ({ ask: l.ask, heard: l.heard, itemId: l.itemId, qty: l.qty, issues: l.issues, ...(vegHidden(l.itemId) && !l.anyway ? { veto: "veg" as const } : {}) })),
      unmatched: d.unmatched.map((u) => u.text),
      tableAmbiguous: !tgt.bill?.placed && wantsTable && !d.tableId && d.tableChoices.length > 1 ? d.tableLabel ?? "table" : null,
      busyTable: busy && !d.tableMode ? d.tableLabel ?? "" : null,
      command: d.command, billOk: tgt.valid,
      hasOther: !!(d.name.trim() || d.phone.trim() || (d.useType && d.type) || (d.useTable && d.tableId)),
    };
  };
  const nameOf = (id: string) => byId.get(id)?.name ?? "";
  /** One dish chosen for an ask line (or a sold-out line): it goes in with the default size, and the till learns the phrase. */
  function chooseDish(key: string, itemId: string) {
    const it = byId.get(itemId);
    if (!it) return;
    const size = lineSize(it, null, true);
    patchLine(key, (x) => ({ ...x, itemId, variantId: size.variantId, defaulted: size.defaulted, ask: false, alternatives: [], issues: x.issues.filter((i) => !/dish/.test(i)), learn: true }));
  }

  /**
   * `run`: also run the spoken command after adding (the confirm tap of "Clear the order"). `via` "done": what "done" adds
   * (soft doubts marked Check, the unresolved rest stays); "go": the same add right before a spoken place / send runs (no Undo:
   * the dishes go to the kitchen next; the sheet is left to the caller). Returns the ticket the dishes went to, how many were
   * added and whether something stayed on the sheet, or null (nothing added: the sheet says why).
   */
  async function apply(d: Draft, run = false, via: "button" | "done" | "go" = "button"): Promise<{ id: string; added: number; leftover: boolean } | null> {
    const name = d.name.trim(), phone = d.phone.trim();
    const pp = phoneProblem(phone);
    if (pp) { setPhoneErr(pp); setStage("confirm"); return null; }
    if (run && d.command === "clear") {
      setSaving(true);
      try { await onCommand?.("clear", ticketKey); } finally { setSaving(false); }
      close(true);
      return null;
    }
    setSaving(true);
    try {
      let customer: Customer | null = null;
      if (name || phone) {
        customer = findCustomer(customers, name, phone) ?? null;
        if (!customer) {
          const r = await createOrFindCustomer({ name, phone });
          customer = r.customer;
          onCustomerCreated(r.customer);
        }
      }
      const tgt = targetOf(d);
      if (!tgt.valid) { setStage("confirm"); return null; }
      // ask lines and sold-out dishes never reach the order (the button is disabled while there are any; this is the guard)
      const lines = d.lines.flatMap((l) => { const item = byId.get(l.itemId); return item && !l.ask && !lineOut(l) ? [{ item, variantId: l.variantId, qty: l.qty, note: l.note ? l.note.charAt(0).toUpperCase() + l.note.slice(1) : null, ...(via !== "button" && isSoft(l, false) ? { check: true } : {}) }] : []; });
      // "done" adds everything that can be added; a dish still to choose, a sold-out one and an unmatched phrase stay on the sheet
      const left = via !== "button" ? d.lines.filter((l) => l.ask || lineOut(l)) : [];
      const partial = via !== "button" && (left.length > 0 || d.unmatched.length > 0);
      const tableId = !placedTarget && d.useType && d.useTable ? d.tableId : null;
      const busy = busyOf(tableId);
      // "dine in" said in a restaurant without tables: the order stays takeaway (nothing to choose)
      const typeSaid = !placedTarget && d.useType ? d.type : null;
      const type = (typeSaid === "indoor" || typeSaid === "outdoor") && !tableId && tables.length === 0 ? null : typeSaid;
      const id = await onApply({ lines, customer, bill: tgt.kind === "no" ? tgt.no : tgt.kind === "new" ? "new" : null, type, tableId,
        tableMode: busy && d.tableMode ? { mode: d.tableMode, orderId: busy.orders[0]?.order_id ?? null } : null });
      if (!id) { setStage("confirm"); return null; }
      teach(d.lines.filter((l) => !l.ask && !lineOut(l)));
      const n = lines.reduce((s, l) => s + l.qty, 0);
      if (via !== "button") {
        const chk = lines.filter((l) => l.check).map((l) => l.item.name);
        if (n || via === "done") toast.success(`${n ? `Added ${n} ${n === 1 ? "item" : "items"} to the cart` : `Updated Bill ${tgt.no}`}${chk.length ? `. ${chk.length} to check: ${chk.join(", ")}` : ""}`, {
          duration: 8000, description: customer ? `Customer: ${customerLabel(customer)}` : undefined,
          // "go": they go to the kitchen next, so no Undo (the order's own buttons change it from here)
          action: via === "done" && n && onUndoApply ? { label: "Undo", onClick: () => onUndoApply(id, lines) } : undefined,
        });
        if (partial) {
          // the rest waits here, aimed at the same bill; the customer, type and table are on the ticket already
          meta.current.command = true; setDraft((prev) => prev && { ...prev, command: null, lines: left, name: "", phone: "", phoneHeardBad: false, useType: false, useTable: false, tableId: null, tableMode: null, tableChoices: [],
            bill: d.tableMode === "join" ? "current" : `no:${tgt.no}` });
          setDoneHeld({ added: n }); setStage("confirm");
          armFollow(); // the rest may wait; "place order" may still follow without "Hey Zonov"
          return { id, added: n, leftover: true };
        }
        if (via === "go") return { id, added: n, leftover: false };
        close(true);
        armFollow(); // hands-free: "place order" may follow without "Hey Zonov"
        learnFromSuccess();
        return { id, added: n, leftover: false };
      }
      toast.success(n ? `${n} ${n === 1 ? "item" : "items"} added to Bill ${tgt.no}` : `Updated Bill ${tgt.no}`,
        customer ? { description: `Customer: ${customerLabel(customer)}` } : undefined);
      close(true);
      return { id, added: n, leftover: false };
    } catch (e) {
      setPhoneErr(null);
      setStage("confirm");
      toast.error(e instanceof ApiError ? (e.status === 0 ? "No connection. Adding a customer needs the server." : e.message) : "Could not add the customer");
      return null;
    } finally { setSaving(false); }
  }

  /** "Add to order" while still listening: what is on screen (words still being heard included) is what gets added. */
  function addNow(run = false) {
    if (stage !== "live") { if (draft) void apply(draft, run); return; }
    const said = liveText(heard).combined;
    endLive("abort");
    const cmd = splitCommand(said, vmenu);
    const d = mergeParsed(draft, parseOrder(withMods(cmd.rest), vmenu, { tables }), meta.current, said, "live", "en", byId, cmd.command);
    setDraft(d);
    if (blockers(withVeto(d.lines), (id) => byId.get(id)?.name ?? "", soldOutId).length) { setStage("confirm"); return; }
    void apply(d, run);
  }

  const count = draft ? draft.lines.reduce((s, l) => s + (l.ask || lineOut(l) ? 0 : l.qty), 0) : 0;
  const draftTableBusy = draft && !placedTarget && draft.useType && draft.useTable ? busyOf(draft.tableId) : null;
  // After "done" left something on the sheet, Add stays disabled for what staff can still settle here (a phrase to pick or drop, a table to choose)
  const holdsNow = draft && doneHeld ? doneHolds(doneState(draft), nameOf, soldOutId) : [];
  const heldExtra = holdsNow.filter((h) => /^pick a dish|^choose the table/.test(h.say)).map((h) => h.reason);
  const blocked = draft ? [
    ...blockers(withVeto(draft.lines), (id) => byId.get(id)?.name ?? "", soldOutId),
    ...(draftTableBusy && !draft.tableMode ? [`Table ${draft.tableLabel ?? ""} already has an order: choose “Add to this table’s order” or “Start a separate order”`] : []),
    ...heldExtra,
  ] : [];
  const canAdd = !!draft && !!target?.valid && !blocked.length && (count > 0 || !!draft.name.trim() || !!draft.phone.trim() || (!placedTarget && ((draft.useType && !!draft.type) || (draft.useTable && !!draft.tableId))));
  const listening = stage === "live";
  /** An outcome in words: a toast (the toaster is itself a polite live region, so screen readers hear it; never silent). */
  function tell(msg: string, tone: "error" | "warning" | "message" | "success") {
    (tone === "error" ? toast.error : tone === "warning" ? toast.warning : tone === "success" ? toast.success : toast.message)(msg, { duration: 8000 });
  }

  const draftRef = useRef(draft);
  draftRef.current = draft;
  /** What the sheet would add now: the dishes that can go in, and whether a customer / type / table is on it. */
  const pendingOf = (d: Draft | null) => {
    const addable = d ? d.lines.filter((l) => !l.ask && !lineOut(l)) : [];
    return { addable, qty: addable.reduce((n, l) => n + l.qty, 0), other: !!d && doneState(d).hasOther };
  };

  /**
   * A spoken "place order" / "send to kitchen" (or the tap on its button): add what is still on the sheet, place the order if it
   * is not placed yet, and send the kitchen ticket, like the counter's buttons (owner rule 2026-11). Spoken, a visible countdown
   * runs first (3 s; 5 s when a dish carries a Check marker; a device setting, 0 = at once). Only what decides WHERE the dishes go
   * holds it (a table to choose, a busy table, a billed bill); a sold-out dish or an unmatched phrase stays on the sheet while the
   * rest goes. The ticket's own rules (empty cart, dine-in without a table...) are checked before. Never billing or payment.
   */
  async function runGo(from: "place" | "kot", tapped = false) {
    const d = draft;
    const st = d ? doneState({ ...d, command: null }) : null;
    const whole = st ? doneHolds(st, nameOf, soldOutId).find((h) => h.whole) : undefined;
    if (whole) {
      phase.current = "listen"; endLive("abort");
      setDoneHeld({ added: 0, command: "kot" }); setStage("confirm");
      tell(holdText("kot", whole.say), "warning");
      return;
    }
    const p = pendingOf(d);
    const tgt = d ? targetOf(d) : null;
    const ticketId = tgt?.bill?.id ?? (tgt && tgt.kind !== "current" ? null : ticketKey);
    const block = tgt?.isNew && p.qty ? null
      : commandCheck?.("kot", ticketId, { items: p.qty, type: d?.useType ? d.type : null, tableId: d?.useType && d.useTable ? d.tableId : null }) ?? null;
    if (block) {
      phase.current = "listen"; endLive("abort");
      if (d && (p.qty || p.other)) await apply(d, false, "done"); else close(true);
      tell(`${commandWords("kot").not}: ${block}.`, "error");
      return;
    }
    const checks = p.addable.filter((l) => l.issues.length).map((l) => `${l.qty} × ${nameOf(l.itemId)}`);
    const secs = tapped ? 0 : countdownSeconds(voiceCountdown.get(), checks.length);
    if (!secs) { await go(); return; }
    phase.current = "command";
    setLeft(secs);
    setCountdown({ from, endsAt: nowMs() + secs * 1000, total: secs, checks });
    setStage("countdown");
  }

  /** The countdown ran out (or "Send now" / the button was tapped): add what is on the sheet, then place + kitchen ticket. */
  async function go() {
    const d = draftRef.current;
    phase.current = "listen"; endLive("abort"); setCountdown(null);
    const tgt = d ? targetOf(d) : null;
    let id = tgt?.bill?.id ?? (tgt && tgt.kind !== "current" ? null : ticketKey);
    let leftover = false;
    const p = pendingOf(d);
    if (d && (p.qty || p.other)) {
      const r = await apply(d, false, "go");
      if (!r) return; // apply said why; the sheet stays
      id = r.id; leftover = r.leftover;
    }
    // hands-free waits until the till's place / KOT finished: starting the background recogniser in the middle of it (and stopping it
    // again when the ticket turns busy) made Chrome refuse the restart, and the wake phrase stopped working (owner bug 2026-11-02)
    executing.current = true;
    if (!leftover) close(true); // a sold-out dish / an unmatched phrase stays on the sheet for staff
    armFollow();
    try {
      const r = await onCommand?.("kot", id);
      setOutcome(r ? r.say : "Sent to the kitchen");
      if (!r || r.ok) learnFromSuccess();
      if (commandText.current) { shareSample(commandText.current.slice(-120), !r || r.ok, "command"); commandText.current = ""; }
    } catch { tell(`${commandWords("kot").not}: something went wrong. Use the buttons on the order.`, "error"); }
    finally { executing.current = false; armed.current = true; void Promise.resolve().then(() => attemptAuto.current()); }
  }

  /** "stop" / "cancel" / "ruko" / "nahi" / "wait", Cancel or closing the sheet during the countdown: the dishes go into the cart, nothing is placed or sent. */
  async function cancelCountdown(how: "said" | "tap") {
    if (!countdownRef.current) return;
    const d = draftRef.current;
    phase.current = "listen"; endLive("abort"); setCountdown(null);
    const p = pendingOf(d);
    if (d && (p.qty || p.other)) await apply(d, false, "done"); else close(true);
    tell(`${commandWords("kot").not}: ${how === "said" ? "you said stop" : "cancelled"}.${p.qty ? " The dishes are in the cart." : ""}`, "message");
  }
  const countdownRef = useRef(countdown);
  countdownRef.current = countdown;
  useEffect(() => {
    if (!countdown) return;
    let fired = false;
    const id = setInterval(() => {
      if (fired) return;
      const l = (countdown.endsAt - nowMs()) / 1000;
      if (l > 0) { setLeft(l); return; }
      fired = true;
      void go();
    }, 100);
    return () => clearInterval(id);
  }, [countdown]); // eslint-disable-line react-hooks/exhaustive-deps

  // Spoken intents (voiceFlow.ts): QUEUED, run once the sheet is ready, never dropped because the server was still reading the
  // order or an add was saving, never run twice. "done" / "add to order": what "Add to order" does for everything that can be added
  // (soft doubts are added and marked "Check"); what cannot be added stays on the sheet with the reason; nothing understood at all:
  // "Nothing to add yet". "place order" / "send to kitchen": runGo. "cancel": its own question on the sheet.
  useEffect(() => {
    if (!intent || taken.current === intent.id) return;
    const step = intentStep({ stage, improving, saving, counting: !!countdown });
    if (step === "wait") return;
    taken.current = intent.id;
    const it = intent;
    void Promise.resolve().then(() => {
      setIntent((cur) => (cur?.id === it.id ? null : cur));
      if (step === "drop" || it.kind === "clear") return;
      if (it.kind === "go") { void runGo(it.from); return; }
      const v = draft ? doneVerdict(doneState({ ...draft, command: null }), nameOf, soldOutId) : { kind: "empty" as const };
      if (v.kind === "add" || v.kind === "partial") { if (draft) void apply(draft, false, "done"); }
      else if (v.kind === "hold") setDoneHeld({ added: 0 });
      else if (v.kind === "empty") { close(); toast.message("Nothing to add yet", { description: "Listening stopped." }); }
    });
  }, [intent, stage, improving, saving, countdown]); // eslint-disable-line react-hooks/exhaustive-deps

  const cmdView = draft?.command ? commandView(draft.command) : null;
  const title = stage === "countdown" && countdown ? commandWords("kot").doing : stage === "confirm" ? (draft?.command === "clear" ? "Clear the order?" : "Check the order") : stage === "typing" ? "Type the order" : stage === "busy" ? "Understanding the order" : "Listening";
  const description = stage === "countdown" ? (live.current ? "Say “stop” or tap Cancel to keep the order as it is." : "Tap Cancel to keep the order as it is.")
    : stage === "confirm" ? (cmdView ? (draft?.command === "clear" ? `You said “${cmdView.heard}”. Nothing happens until you tap “${cmdView.button}”.` : `You said “${cmdView.heard}”. Fix what is marked, then tap “${cmdView.button}”.`) : `Nothing is added to ${ticketLabel} until you tap “Add to order”.`)
    : stage === "typing" ? "Write it the way you would say it, in English or Hinglish."
      : stage === "busy" ? undefined
        : listening ? `Dishes appear as you speak. Say “done” or tap “Add to order” to add them to ${ticketLabel}.`
          : "Say the dishes with quantities, then the customer's name and number.";

  // Phones: secondary actions share one row, the main action sits full-width below (thumb reach); a row from `sm` up.
  // `stack`: long labels ("Add and send to kitchen") keep the phone layout at every width instead of wrapping inside the buttons.
  const row = (a: ReactNode, b: ReactNode, main: ReactNode, stack = false) => (
    <div className={cn("grid w-full grid-cols-2 gap-2 [&>*:last-child]:col-span-2 [&>*]:whitespace-nowrap", !stack && "sm:flex sm:w-auto sm:justify-end")}>{a}{b}{main}</div>
  );
  const blockedNote = blocked.length ? "voice-blocked" : undefined;
  const addButton = <Button variant="primary" size="lg" loading={saving} disabled={!canAdd || improving} aria-describedby={blockedNote} onClick={() => addNow()}>Add to order{count ? ` (${count})` : ""}</Button>;
  let footer: ReactNode;
  if (stage === "recording" || stage === "starting") footer = row(
    <Button variant="secondary" iconStart={<Keyboard />} onClick={typeInstead}>Type instead</Button>,
    <Button variant="ghost" onClick={() => close()}>Cancel</Button>,
    <Button variant="primary" size="lg" iconStart={<Square />} disabled={stage === "starting"} onClick={stop}>Stop and check</Button>);
  else if (listening) footer = row(
    <Button variant="ghost" onClick={() => close()}>Cancel</Button>,
    <Button variant="secondary" iconStart={<Square />} onClick={stopLive}>Stop</Button>,
    addButton);
  else if (stage === "typing") footer = row(
    <Button variant="ghost" onClick={() => close()} className={!micNote && online ? undefined : "col-span-2"}>Cancel</Button>,
    !micNote && online ? <Button variant="secondary" iconStart={<Mic />} onClick={start}>Speak instead</Button> : null,
    <Button variant="primary" size="lg" iconStart={<Sparkles />} disabled={!text.trim()} onClick={understandTyped}>Understand</Button>);
  else if (stage === "confirm" && draft?.command === "clear") footer = row(
    <Button variant="ghost" disabled={saving} onClick={() => close()}>Cancel</Button>,
    <Button variant="secondary" disabled={saving} onClick={() => { meta.current.command = true; setDraft((d) => d && { ...d, command: null }); }}>Keep the order</Button>,
    <Button variant="danger-solid" size="lg" iconStart={<Trash2 />} loading={saving} onClick={() => void apply(draft, true)}>Clear the order</Button>, true);
  else if (stage === "countdown" && countdown) footer = row(
    <Button variant="ghost" size="lg" className="col-span-2" onClick={() => cancelCountdown("tap")}>Cancel</Button>,
    null,
    <Button variant="primary" size="lg" iconStart={<Send />} onClick={() => void go()}>Send now</Button>, true);
  else if (stage === "confirm" && cmdView) footer = row(
    <Button variant="ghost" disabled={saving} onClick={() => close()}>Cancel</Button>,
    <Button variant="secondary" disabled={!canAdd || improving || saving} aria-describedby={blockedNote} onClick={() => addNow()}>Add only</Button>,
    // no new dishes is fine: the order on the ticket is placed / sent as it is (a placed order's "send to kitchen")
    <Button variant="primary" size="lg" iconStart={<Send />} loading={saving} disabled={improving || saving || blocked.length > 0 || (!!target && !target.valid)} aria-describedby={blockedNote}
      onClick={() => void runGo(draft!.command === "place" ? "place" : "kot", true)}>{cmdView.button}{count ? ` (${count})` : ""}</Button>, true);
  else if (stage === "confirm") footer = row(
    <Button variant="ghost" disabled={saving} onClick={() => close()}>Cancel</Button>,
    <Button variant="secondary" iconStart={<RotateCcw />} disabled={saving} onClick={start}>Again</Button>,
    addButton);

  const hf = handsFreeLabel({ on: auto, listening: quiet, trouble, alive: srAlive, sleep: idleNote, wait: lang !== "en" ? "Hands-free works in English only" : waitNote });
  const micEnabledOffline = onDevice && lang === "en";
  const micOnline = online || micEnabledOffline;

  return (
    <>
      <div className="flex max-w-full shrink-0 flex-wrap items-center gap-1.5">
        {/* Offline: aria-disabled (not `disabled`) so a tap can still say why. Hands-free state lives in the tooltip and the
            screen-reader status, never in a bubble over the category chips (audit C-23). */}
        <button type="button" disabled={disabled} aria-disabled={!micOnline || undefined} onClick={start} data-speech={speechNow ? "on" : undefined}
          aria-label={quiet ? "Voice order (waiting for Hey Zonov)" : micOnline ? "Voice order" : "Voice order (needs internet)"}
          aria-describedby={auto ? "voice-hf-status" : undefined}
          title={auto && hf.state !== "listening" ? hf.long : micOnline ? (lang === "en" && liveSpeechUsable() ? "Speak an order: dishes appear as you talk" : "Speak an order") : "Voice ordering needs an internet connection"}
          className={cn("relative grid size-12 shrink-0 place-items-center rounded-2xl border bg-surface text-primary shadow-xs transition-colors hover:bg-primary-soft disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:text-fg-subtle aria-disabled:opacity-60 aria-disabled:hover:bg-surface",
            "transition-transform duration-150", pressed && "scale-90 border-primary bg-primary-soft ring-4 ring-primary/30",
            speechNow && !pressed && "ring-2 ring-primary/40", // the mic detector hears speech right now (within ~100 ms)
            quiet ? "border-danger text-danger-fg" : auto && hf.state === "paused" && (idleNote || waitNote) ? "border-warning" : "border-border")}>
          {quiet && <span aria-hidden className="absolute inset-0 animate-ping rounded-2xl bg-danger-solid/20 motion-reduce:hidden" />}
          {micOnline ? <Mic aria-hidden className="relative size-5" /> : <MicOff aria-hidden className="relative size-5" />}
          {/* a problem is a shape (!) as well as a colour, inside the button's own box */}
          {auto && hf.state === "paused" && (idleNote || trouble) && (
            <span aria-hidden className="absolute -right-1 -top-1 grid size-4 place-items-center rounded-full border border-warning bg-warning-soft text-[0.65rem] font-bold leading-none text-warning-fg">!</span>
          )}
        </button>
        {/* Spoken language: a native select (full names for screen readers) shown as a short code to save room. Hidden while the app is English only (owner rule). */}
        {LANGUAGES_ENABLED && <label className="relative grid h-12 min-w-11 place-items-center rounded-2xl border border-border bg-surface px-2 text-xs font-bold tracking-wide text-fg-muted shadow-xs focus-within:ring-2 focus-within:ring-ring hover:bg-surface-2">
          <span aria-hidden>{VOICE_LANGS.find((l) => l.value === lang)!.short}</span>
          <select aria-label="Voice language" value={lang} onChange={(e) => writeLang(e.target.value as VoiceLang)}
            className="absolute inset-0 size-full cursor-pointer appearance-none opacity-0">
            {VOICE_LANGS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
          </select>
        </label>}
        {/* Hands-free switch with its state in words: Listening / Paused / Off (the manual off switch). */}
        {(
        <button type="button" aria-pressed={auto} data-testid="hands-free" onClick={() => writeAuto(!auto)} title={hf.long}
            aria-label={`Hands-free “Hey Zonov”: ${hf.short}`}
            className={cn("inline-flex h-12 min-w-12 shrink-0 items-center justify-center gap-1.5 rounded-2xl border px-2.5 text-xs font-semibold shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              !auto ? "border-border bg-surface text-fg-muted hover:bg-surface-2"
                : hf.state === "listening" ? "border-danger/40 bg-danger-soft text-danger-fg" : "border-warning bg-warning-soft text-warning-fg")}>
            {!auto ? <MicOff aria-hidden className="size-4" /> : <Mic aria-hidden className="size-4" />}
            <span aria-hidden>{auto ? "Mic on" : "Mic off"}</span>
          </button>
        )}
        {/* Honest status of hands-free for screen readers (the visible words are on the switch and in the mic's tooltip). */}
        {/* Voice settings of this device (countdown, wake sensitivity, train "Hey Zonov", the mic reset); a "Reset mic" next to the
            switch while hands-free cannot listen. */}
        {auto && ((hf.state === "paused" && (idleNote === "sleeping" || idleNote === "nomic" || idleNote === "tap")) || !!trouble) && (
          <Button size="sm" variant="secondary" data-testid="voice-reset" onClick={resetMic}>Mic not working? Reset</Button>
        )}
        <VoiceSettings onResetMic={resetMic} pauseHandsFree={() => { if (quietRef.current) quietStop("dialog"); }} />
        {showVoiceChips && directActive && <span data-testid="direct-mode" title="Spoken dishes go straight into the selected bill (no Hey Zonov needed). Voice settings turns it off." className="inline-flex h-8 items-center rounded-full border border-primary/40 bg-primary-soft px-2.5 text-[0.7rem] font-bold text-primary-soft-fg">Direct mode ON</span>}
        {detector.state === "loading" && <span data-testid="voice-engine-loading" className="inline-flex h-8 items-center rounded-full border border-border bg-surface-2 px-2.5 text-[0.7rem] font-semibold text-fg-muted">Loading voice engine{detector.note && /MB left/.test(detector.note) ? ` (${detector.note})` : "…"}</span>}
        {showVoiceChips && <MicDebug state={hf.short} handsFree={auto} lang={lang} detector={detector.state} />}
        {/* What the countdown and the till's action did ("Bill 1: sent to the kitchen"), for screen readers; the other outcomes are toasts (a live region too). */}
        <p role="status" aria-live="polite" data-testid="voice-outcome" className="sr-only">{outcome}</p>
        <p id="voice-hf-status" role="status" data-testid="auto-status" className="sr-only">
          {!auto ? "" : quiet ? hf.long
            : idleNote === "tap" ? `Tap the mic to start listening (this browser needs a tap first${lastSpeechError ? `: ${lastSpeechError}` : ""})`
              : idleNote ? hf.long
                : waitNote && lang === "en" ? waitNote
                  : lang !== "en" ? "Hands-free works in English only" : ""}
        </p>
      </div>

      <Dialog open={stage !== "closed"} onOpenChange={(o) => { if (!o && !saving) { if (countdown) cancelCountdown("tap"); else close(); } }} title={title} description={description} footer={footer}>
        {stage === "countdown" && countdown && (
          <div data-testid="voice-countdown" className="space-y-3 rounded-2xl border border-primary/40 bg-primary-soft p-4">
            <p role="status" aria-live="assertive" className="text-base font-semibold text-fg">{countdownText("kot", left, countdown.total, !!live.current)}</p>
            <div aria-hidden className="h-2.5 overflow-hidden rounded-full bg-surface">
              <div className="h-full rounded-full bg-primary transition-[width] duration-100 ease-linear" style={{ width: `${Math.max(0, Math.min(100, (left / countdown.total) * 100))}%` }} />
            </div>
            {countdown.checks.length > 0 && (
              <p data-testid="voice-countdown-checks" className="flex items-start gap-1.5 text-sm font-semibold text-warning-fg"><TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                To check: {countdown.checks.join(", ")}. Change a dish below, or say “stop”.</p>
            )}
            <p className="text-sm text-fg-muted">
              {draft?.lines.length ? "The dishes below go into the cart, the order is placed (if it is not yet) and its kitchen ticket is sent." : "The order is placed (if it is not yet) and its kitchen ticket is sent."} There is no undo once the kitchen has it. Billing and payment are never done by voice.
            </p>
          </div>
        )}
        {(stage === "recording" || stage === "starting") && (
          <div className="flex flex-col items-center gap-3 py-6" aria-live="polite">
            <div className="relative grid size-28 place-items-center">
              {stage === "recording" && <span aria-hidden className="absolute inset-0 animate-ping rounded-full bg-danger-solid/25" />}
              <span className="relative grid size-24 place-items-center rounded-full bg-danger-solid text-white shadow-[var(--shadow-glow)]">
                <Mic aria-hidden className="size-10" />
              </span>
            </div>
            <p className="font-display text-3xl font-bold tnum text-fg" data-testid="voice-timer">{mmss(secs)}<span className="text-base font-medium text-fg-subtle"> / {mmss(MAX_RECORD_SECONDS)}</span></p>
            <p className="text-sm font-semibold text-danger-fg">{stage === "starting" ? "Starting the microphone…" : "Recording"}</p>
            <p className="max-w-sm text-center text-xs text-fg-muted">
              {lang === "en" ? "e.g. “2 chicken tikka masala, 1 garlic naan, customer name Raj, number 07700 900123”"
                : `Speak in ${langLabel(lang)}. The AI reads the recording when you stop.`}
            </p>
          </div>
        )}

        {listening && (
          <div className="sticky top-0 z-10 -mx-1 mb-3 rounded-2xl border border-danger/30 bg-surface px-3 py-2.5 shadow-xs" data-testid="voice-live">
            <div className="flex items-center gap-2.5">
              <span className="relative grid size-9 shrink-0 place-items-center">
                <span aria-hidden className="absolute inset-0 animate-ping rounded-full bg-danger-solid/25" />
                <span className="relative grid size-9 place-items-center rounded-full bg-danger-solid text-white"><Mic aria-hidden className="size-4" /></span>
              </span>
              <p data-testid={woke ? "voice-woke" : undefined} className="flex-1 text-sm font-semibold text-danger-fg">{woke ? "Hey Zonov heard: listening…" : "Listening"}{onDevice && !online ? " (on this device, offline)" : ""}</p>
              <p className="font-display text-lg font-bold tnum text-fg" data-testid="voice-timer">{mmss(secs)}</p>
            </div>
            <p aria-live="polite" data-testid="voice-transcript" className="mt-2 max-h-24 overflow-y-auto text-sm leading-snug text-fg">
              {heard.finalText || heard.interim ? (
                <>{heard.finalText}{heard.interim && <span className="italic text-fg-subtle">{heard.finalText ? " " : ""}{heard.interim}</span>}</>
              ) : <span className="text-fg-muted">{woke ? `Say the order, e.g. “bill number 2, two lamb karahi, ${biz.dine_in ? "dine in table 5" : "delivery"}, name Raj”.` : "Speak now, e.g. “do lamb karahi, ek garlic naan, mango lassi jug, customer name Raj, takeaway”."}</span>}
            </p>
          </div>
        )}

        {stage === "busy" && (
          <div role="status" className="flex flex-col items-center gap-3 py-10 text-fg-muted">
            <Spinner className="size-8" />
            <p className="text-sm">The AI is matching what was said to the menu…</p>
          </div>
        )}

        {stage === "typing" && (
          <div className="space-y-3 pb-3">
            {micNote && <p role="alert" className="flex items-start gap-2 rounded-xl bg-warning-soft px-3 py-2 text-sm text-warning-fg"><MicOff aria-hidden className="mt-0.5 size-4 shrink-0" />{micNote}</p>}
            {error && <p role="alert" className="rounded-xl bg-danger-soft px-3 py-2 text-sm text-danger-fg">{error}</p>}
            <Textarea label="Order" autoFocus value={text} onChange={(e) => setText(e.target.value)} maxLength={2000}
              placeholder="2 chicken tikka masala, 1 garlic naan, customer name Raj, number 07700 900123" />
            {!online && <p className="text-xs text-fg-muted">You are offline: dishes are matched on this device; the AI is not available.</p>}
          </div>
        )}

        {(stage === "confirm" || stage === "countdown" || listening) && draft && (
          <div className="space-y-4 pb-3">
            {stage === "confirm" && (() => {
              const by = understoodBy(draft.source, draft.modelUsed, draft.aiImproved);
              return (
                <p data-testid="voice-source" data-ai={by.ai ? "true" : "false"} title={sourceDetail(draft)} className="flex items-center gap-1.5 text-xs font-medium text-fg-muted">
                  {by.ai ? <Sparkles aria-hidden className="size-3.5" /> : <Cpu aria-hidden className="size-3.5" />}{by.short}
                  <span className="sr-only">. {sourceDetail(draft)}</span>
                </p>
              );
            })()}
            {/* Results announced once the sheet settles (screen readers): how many dishes, and what still needs a choice. */}
            {stage === "confirm" && (
              <p role="status" aria-live="polite" data-testid="voice-announce" className="sr-only">
                {`${count} ${count === 1 ? "item" : "items"} ready.`}{blocked.length ? ` ${blocked.length} to check: ${blocked.join(". ")}.` : ""}{cmdView ? ` You said “${cmdView.heard}”.` : ""}
              </p>
            )}
            {stage === "confirm" && doneHeld && holdsNow.length > 0 && (
              <p role="status" data-testid="voice-done-hold" className="flex items-start gap-2 rounded-xl border border-warning bg-warning-soft px-3 py-2.5 text-sm font-semibold text-warning-fg">
                <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />{doneHeld.command ? holdText(doneHeld.command, holdsNow[0].say) : holdMessage(holdsNow, doneHeld.added)}
              </p>
            )}
            {stage === "confirm" && cmdView && (
              <div data-testid="voice-command" className={cn("flex items-start gap-2.5 rounded-xl border p-3", cmdView.tone === "danger" ? "border-danger/40 bg-danger-soft" : "border-primary/40 bg-primary-soft")}>
                {cmdView.tone === "danger" ? <Trash2 aria-hidden className="mt-0.5 size-4 shrink-0 text-danger-fg" /> : <Send aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />}
                <div className="min-w-0 text-sm">
                  <p className="font-semibold text-fg">Heard: “{cmdView.heard}”</p>
                  <p className="text-fg-muted">{draft.command === "clear" ? `${cmdView.explain} Nothing already sent to the kitchen is cancelled.` : cmdView.explain}</p>
                </div>
              </div>
            )}
            {stage === "confirm" && draft.transcript && <p className="rounded-xl bg-surface-2 px-3 py-2 text-sm italic text-fg-muted">“{draft.transcript}”</p>}

            <section aria-label="Add to bill" className="space-y-1.5">
              <label className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">Add to</span>
                <select aria-label="Add to" value={target?.valid ? (target.kind === "current" ? `no:${target.no}` : target.kind === "new" ? "new" : `no:${target.no}`) : ""}
                  onChange={(e) => setDraftBill(e.target.value)}
                  className="h-11 min-w-0 flex-1 rounded-xl border border-border-strong bg-surface px-3 text-sm font-semibold text-fg">
                  {!target?.valid && <option value="" disabled>Choose a bill…</option>}
                  {bills.map((b) => (
                    <option key={b.id} value={`no:${b.no}`} disabled={b.locked}>
                      Bill {b.no} ({b.locked ? "billed: cannot add" : b.placed ? `placed, ${b.itemCount} ${b.itemCount === 1 ? "item" : "items"}: adds new items` : `open, ${b.itemCount} ${b.itemCount === 1 ? "item" : "items"}`}){b.id === ticketKey ? " · this ticket" : ""}
                    </option>
                  ))}
                  {target?.kind === "no" && target.isNew && <option value={`no:${target.no}`}>Bill {target.no} (new)</option>}
                  <option value="new">New bill (Bill {nextNo})</option>
                </select>
              </label>
              {target && (target.valid
                ? <p data-testid="voice-target" className="text-xs font-semibold text-fg-muted">Adding to {targetText(target)}</p>
                : <p data-testid="voice-target" role="alert" className="flex items-center gap-1.5 text-xs font-semibold text-warning-fg"><TriangleAlert aria-hidden className="size-3.5" />
                  Bill {target.no} is already billed, so nothing can be added to it. Choose another bill or a new bill.</p>)}
            </section>

            <section aria-label="Items heard">
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">Items</h3>
              {draft.lines.length === 0 && (
                <p className="py-2 text-sm text-fg-muted">{listening ? "Dishes will appear here as you speak." : improving ? "Asking the AI…" : stage === "countdown" ? "Nothing new to add: the order in the cart goes as it is." : "No dishes matched. Pick them below or add them from the menu."}</p>
              )}
              <ul className="grid gap-2">
                {draft.lines.map((l) => {
                  const item = byId.get(l.itemId);
                  if (!item) return null;
                  if (l.ask) {
                    // Several dishes fit: ask, with big tap targets (never pre-selected, never added before a tap)
                    const opts = [item.id, ...(l.alternatives ?? [])].filter((id, i, a) => byId.has(id) && a.indexOf(id) === i);
                    return (
                      <li key={l.key} data-testid="voice-line" data-ask="true" data-pending={l.pending ? "true" : undefined}
                        className={cn("rounded-xl border-2 border-dashed border-warning bg-warning-soft/60 p-3", l.pending && "opacity-60")}>
                        <div className="flex items-start gap-2">
                          <p className="min-w-0 flex-1 text-sm font-semibold text-fg"><TriangleAlert aria-hidden className="mr-1 inline size-4 align-[-3px] text-warning-fg" />Which dish? <span className="font-normal text-fg-muted">Heard “{l.heard}”{l.qty > 1 ? ` × ${l.qty}` : ""}</span></p>
                          <IconButton label={`Drop “${l.heard}”`} icon={<Trash2 />} variant="ghost" onClick={() => patchLine(l.key, () => null)} />
                        </div>
                        <div role="group" aria-label={`Which dish for “${l.heard}”`} className="mt-2 grid gap-2 sm:grid-cols-2">
                          {opts.map((id) => {
                            const it = byId.get(id)!;
                            const out = isSoldOut?.(it);
                            return (
                              <button key={id} type="button" disabled={out} onClick={() => chooseDish(l.key, id)}
                                className="flex min-h-12 items-center justify-between gap-2 rounded-xl border border-border-strong bg-surface px-3 py-2 text-left text-sm font-semibold text-fg shadow-xs hover:border-primary hover:bg-primary-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60">
                                <span className="min-w-0">{it.name}<span className="block text-xs font-normal text-fg-muted">{out ? "Sold out" : catName.get(it.category_id) ?? ""}</span></span>
                                <Money value={sumMoney([it.price, it.variants.find((v) => v.id === lineSize(it, null, true).variantId)?.price_delta ?? "0"])} currency={currency} />
                              </button>
                            );
                          })}
                        </div>
                      </li>
                    );
                  }
                  const v = item.variants.find((x) => x.id === l.variantId);
                  const unit = sumMoney([item.price, v?.price_delta ?? "0"]);
                  const out = !!isSoldOut?.(item);
                  const vegOut = !out && vegHidden(item.id) && !l.anyway;
                  const review = l.issues.length > 0 || out || vegOut;
                  const alts = (l.alternatives ?? []).filter((id) => byId.has(id) && id !== item.id);
                  const sw = sizeSwitch(item, l.variantId);
                  return (
                    <li key={l.key} data-testid="voice-line" data-pending={l.pending ? "true" : undefined} data-sold-out={out ? "true" : undefined}
                      className={cn("rounded-xl border p-3 transition-opacity", out ? "border-danger bg-danger-soft/60" : review ? "border-warning bg-warning-soft/60" : "border-border bg-surface", l.pending && "opacity-60")}>
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="font-semibold text-fg">{item.name}{v ? <span className="font-medium text-fg-muted"> · {v.name}</span> : null}
                            {v && l.defaulted && <span className="ml-1.5 text-xs font-medium text-fg-subtle">(default size)</span>}</p>
                          {l.heard && <p className="truncate text-xs text-fg-muted">{l.pending ? "Hearing" : "Heard"} “{l.heard}”</p>}
                        </div>
                        {out ? <span data-testid="voice-sold-out" className="inline-flex shrink-0 items-center gap-1 rounded-full border border-danger px-2 py-0.5 text-xs font-bold text-danger-fg"><Ban aria-hidden className="size-3.5" />Sold out</span>
                          : <Money value={mulMoney(unit, l.qty)} currency={currency} strong />}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {!out && <QtyStepper value={l.qty} min={1} max={99} incLabel={`Add one ${item.name}`} decLabel={`Remove one ${item.name}`}
                          onIncrement={() => patchLine(l.key, (x) => ({ ...x, qty: Math.min(x.qty + 1, 99) }))}
                          onDecrement={() => patchLine(l.key, (x) => ({ ...x, qty: Math.max(x.qty - 1, 1) }))} />}
                        {(alts.length > 0 || out) && (
                          <select aria-label={out ? `Another dish instead of ${item.name}` : `Which dish for “${l.heard}”`} value={out ? "" : item.id}
                            onChange={(e) => { if (e.target.value) chooseDish(l.key, e.target.value); }}
                            className="h-11 min-w-0 flex-1 rounded-xl border border-border-strong bg-surface px-3 text-sm text-fg">
                            {out && <option value="">Choose another dish…</option>}
                            {(out ? [...alts, ...grouped.flatMap((g) => g.items.map((i) => i.id))] : [item.id, ...alts]).filter((id, i, a) => a.indexOf(id) === i && (!out || !soldOutId(id))).map((id) =>
                              <option key={id} value={id}>{byId.get(id)!.name} · {catName.get(byId.get(id)!.category_id) ?? ""}</option>)}
                          </select>
                        )}
                        {!out && sw && sw.to.map((o) => (
                          <button key={o.id ?? "regular"} type="button"
                            onClick={() => patchLine(l.key, (x) => ({ ...x, variantId: o.id, defaulted: false, issues: x.issues.filter((i) => !i.startsWith("option")) }))}
                            className="inline-flex min-h-11 items-center gap-1 rounded-xl border border-border-strong bg-surface px-3 text-sm font-semibold text-fg hover:border-primary hover:bg-primary-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                            <span className="sr-only">Change to </span>{o.label}
                          </button>
                        ))}
                        <IconButton label={`Drop ${item.name}`} icon={<Trash2 />} variant="ghost" className="ml-auto" onClick={() => patchLine(l.key, () => null)} />
                      </div>
                      {(l.said ?? 1) > 1 && <p data-testid="voice-merged" className="mt-1.5 text-xs font-semibold text-primary">Said {l.said} times: now ×{l.qty}</p>}
                      {l.learn && l.heard && (
                        <label data-testid="voice-remember" className="mt-1.5 flex min-h-11 cursor-pointer items-center gap-2 text-xs text-fg-muted">
                          <input type="checkbox" className="size-4 accent-primary" checked={l.remember !== false}
                            onChange={(e) => { const on = e.target.checked; patchLine(l.key, (x) => ({ ...x, remember: on })); }} />
                          <span>Remember “{l.heard}” as {item.name} for next time</span>
                        </label>
                      )}
                      {l.note && <p className="mt-1.5 text-xs text-fg-muted"><span className="font-semibold text-fg">Note:</span> {l.note} <span className="text-fg-subtle">(goes on the kitchen ticket)</span></p>}
                      {out && <p className="mt-1.5 flex items-center gap-1.5 text-xs font-semibold text-danger-fg"><Ban aria-hidden className="size-3.5" />{item.name} is sold out today: choose another dish or drop it.</p>}
                      {vegOut && (
                        <div data-testid="voice-veg-veto" className="mt-1.5 flex flex-wrap items-center gap-2">
                          <p className="flex items-center gap-1.5 text-xs font-semibold text-warning-fg"><TriangleAlert aria-hidden className="size-3.5" />{item.name} is non-veg and Veg only is on.</p>
                          <Button size="sm" variant="secondary" onClick={() => patchLine(l.key, (x) => ({ ...x, anyway: true }))}>Add anyway</Button>
                        </div>
                      )}
                      {!out && review && <p className="mt-1.5 flex items-center gap-1.5 text-xs font-semibold text-warning-fg"><TriangleAlert aria-hidden className="size-3.5" />{l.issues.join("; ")}</p>}
                    </li>
                  );
                })}
              </ul>
            </section>

            {draft.unmatched.length > 0 && (
              <section aria-label="Not matched">
                <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold uppercase tracking-[0.06em] text-warning-fg">Not matched: pick a dish or drop</h3>
                  {online && !listening && (
                    <Button size="sm" variant="secondary" iconStart={<Sparkles />} loading={improving} onClick={() => void improveWithAi()}>Improve with AI</Button>
                  )}
                </div>
                <ul className="grid gap-2">
                  {draft.unmatched.map((u) => (
                    <li key={u.key} data-testid="voice-unmatched" className={cn("rounded-xl border border-dashed border-warning bg-warning-soft/40 p-3", u.pending && "opacity-60")}>
                      <p className="text-sm font-semibold text-warning-fg">“{u.text}”</p>
                      <div className="mt-2 flex items-center gap-2">
                        <select aria-label={`Pick a dish for “${u.text}”`} value="" onChange={(e) => pickForUnmatched(u.key, e.target.value)}
                          className="h-11 min-w-0 flex-1 rounded-xl border border-border-strong bg-surface px-3 text-sm text-fg">
                          <option value="">Pick a dish…</option>
                          {grouped.map((g) => <optgroup key={g.cat.id} label={g.cat.name}>{g.items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</optgroup>)}
                        </select>
                        <IconButton label={`Drop “${u.text}”`} icon={<Trash2 />} variant="ghost"
                          onClick={() => { meta.current.dropped.add(u.key); setDraft((d) => d && { ...d, unmatched: d.unmatched.filter((x) => x.key !== u.key) }); }} />
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {stage === "confirm" && blocked.length > 0 && (
              <ul id="voice-blocked" data-testid="voice-blocked" className="space-y-1 rounded-xl border border-warning bg-warning-soft/60 px-3 py-2 text-xs font-semibold text-warning-fg">
                {blocked.map((b) => <li key={b} className="flex items-start gap-1.5"><TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />{b}</li>)}
              </ul>
            )}

            {(stage === "confirm" || draft.name || draft.phone) && (
              <section aria-label="Customer" className="space-y-2">
                <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.06em] text-fg-subtle"><User aria-hidden className="size-3.5" />Customer (optional)</h3>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input label="Customer name" autoComplete="off" value={draft.name} placeholder="Name"
                    onChange={(e) => { meta.current.name = true; setDraft((d) => d && { ...d, name: e.target.value }); }} />
                  <Input label="Customer phone" type="tel" inputMode="tel" autoComplete="off" value={draft.phone} placeholder={phoneHint()} error={phoneErr ?? undefined}
                    onChange={(e) => { meta.current.phone = true; setPhoneErr(null); setDraft((d) => d && { ...d, phone: e.target.value }); }} />
                </div>
                {draft.phoneHeardBad && !phoneErr && <p className="text-xs text-warning-fg">Check this number: it did not look like a valid phone number.</p>}
                {(draft.name.trim() || draft.phone.trim()) && (() => {
                  const hit = findCustomer(customers, draft.name, draft.phone);
                  return <p className="text-xs text-fg-muted">{hit ? `Existing customer: ${customerLabel(hit)} will be selected.` : "A new customer will be saved and selected."}</p>;
                })()}
              </section>
            )}

            {placedTarget && (draft.useType || draft.useTable) && (
              <p data-testid="voice-not-applied" className="text-xs font-semibold text-warning-fg">
                Not applied: order already placed.{draft.type ? ` ${TYPE_NAME[draft.type]}${draft.tableLabel ? ` · ${draft.tableLabel}` : ""} was heard, but the order type and table cannot change after placing.` : ""}</p>
            )}

            {!placedTarget && (stage === "confirm" || draft.type || draft.tableLabel) && (() => {
              const typeOn = draft.useType && !!draft.type;
              const wantsTable = typeOn && (draft.type === "indoor" || draft.type === "outdoor");
              const active = tables.filter((t) => t.is_active !== false);
              const ofArea = active.filter((t) => t.area === draft.type);
              const choices = ofArea.length ? ofArea : active;
              const clash = wantsTable && draft.tableId ? claims?.get(draft.tableId) : undefined;
              const selectCls = "h-11 w-full min-w-0 rounded-xl border border-border-strong bg-surface px-3 text-sm text-fg";
              return (
                <section aria-label="Order details" className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">{biz.tables ? "Order type and table" : "Order type"}</h3>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <select aria-label="Order type" value={typeOn ? draft.type! : ""} onChange={(e) => setDraftType(e.target.value)} className={selectCls}>
                      <option value="">Keep the ticket&apos;s order type</option>
                      {orderTypes.map((t) => <option key={t} value={t}>{TYPE_NAME[t]}</option>)}
                    </select>
                    {wantsTable && (
                      <select aria-label="Table" value={draft.useTable && draft.tableId ? draft.tableId : ""} onChange={(e) => setDraftTable(e.target.value)} className={selectCls}>
                        <option value="">Choose a table…</option>
                        {choices.map((t) => <option key={t.id} value={t.id}>{t.label}{ofArea.length ? "" : ` · ${TYPE_NAME[t.area]}`}</option>)}
                      </select>
                    )}
                  </div>
                  {wantsTable && !draft.tableId && draft.tableChoices.length > 1 && (
                    <div role="group" aria-label="Which table?" data-testid="voice-table-choices" className="space-y-1.5">
                      <p className="flex items-center gap-1.5 text-xs font-semibold text-warning-fg"><TriangleAlert aria-hidden className="size-3.5" />“{draft.tableLabel}” fits more than one table. Which table?</p>
                      <div className="flex flex-wrap gap-2">
                        {draft.tableChoices.map((id) => { const t = tables.find((x) => x.id === id); return t ? (
                          <button key={id} type="button" onClick={() => setDraftTable(id)}
                            className="min-h-11 min-w-16 rounded-xl border border-border-strong bg-surface px-3 text-sm font-bold text-fg hover:border-primary hover:bg-primary-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                            {t.label}<span className="ml-1 text-xs font-normal text-fg-muted">{TYPE_NAME[t.area]}</span></button>) : null; })}
                      </div>
                    </div>
                  )}
                  {wantsTable && !draft.tableId && draft.tableChoices.length <= 1 && (
                    <p data-testid="voice-table-hint" className="flex items-center gap-1.5 text-xs font-semibold text-warning-fg"><TriangleAlert aria-hidden className="size-3.5" />
                      {draft.tableLabel ? `Table “${draft.tableLabel}” was not found. ` : `${TYPE_NAME[draft.type!]} needs a table. `}Choose a table (you can also do it on the ticket).</p>
                  )}
                  {draftTableBusy && (() => {
                    const items = draftTableBusy.orders.reduce((n, o) => n + (o.item_count ?? 0), 0);
                    const total = draftTableBusy.orders.reduce((n, o) => n + Number(o.subtotal ?? 0), 0);
                    const pick = (m: "join" | "separate") => { meta.current.table = true; setDraft((d) => d && { ...d, tableMode: m }); };
                    return (
                      <div role="group" aria-label={`Table ${draft.tableLabel} already has an order`} data-testid="voice-busy-table" className="space-y-2 rounded-xl border border-warning bg-warning-soft/60 p-3">
                        <p className="flex items-center gap-1.5 text-sm font-semibold text-warning-fg"><TriangleAlert aria-hidden className="size-4" />Table {draft.tableLabel} already has an order{items ? ` (${items} ${items === 1 ? "item" : "items"} · ${formatCurrency(total.toFixed(2), currency)})` : ""}</p>
                        <div className="grid gap-2 sm:grid-cols-2">
                          {(["join", "separate"] as const).map((m) => (
                            <button key={m} type="button" aria-pressed={draft.tableMode === m} onClick={() => pick(m)}
                              className={cn("flex min-h-12 items-center gap-2 rounded-xl border px-3 text-left text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                draft.tableMode === m ? "border-primary bg-primary-soft text-fg ring-1 ring-primary" : "border-border-strong bg-surface text-fg hover:bg-surface-2")}>
                              {draft.tableMode === m ? <Check aria-hidden className="size-4 shrink-0 text-primary" /> : <span aria-hidden className="size-4 shrink-0 rounded-full border border-border-strong" />}
                              {m === "join" ? "Add to this table’s order" : "Start a separate order"}
                            </button>
                          ))}
                        </div>
                        <p className="text-xs text-fg-muted">A separate order gets its own bill (for example a second group at the same table).</p>
                      </div>
                    );
                  })()}
                  {clash && clash.length > 0 && <p className="text-xs font-semibold text-warning-fg">Table {draft.tableLabel} is also chosen on {clash.join(", ")}.</p>}
                  {typeOn && <p className="text-xs text-fg-muted">The ticket becomes {TYPE_NAME[draft.type!]}{wantsTable && draft.tableId ? ` · ${draft.tableLabel}` : ""}. GST and service charge follow the order type as usual.</p>}
                </section>
              );
            })()}
          </div>
        )}
      </Dialog>
    </>
  );
}
