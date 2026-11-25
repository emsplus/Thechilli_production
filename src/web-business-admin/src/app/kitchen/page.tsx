"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bike, ChevronDown, LogOut, Maximize2, Minimize2, Printer, RefreshCw, ShoppingBag, Sun, Utensils, Volume2, VolumeX, X, type LucideIcon } from "lucide-react";
import { Button, EmptyState, IconButton, Notice, Skeleton, type Locale } from "@chilli/ui";
import { KdsBoard, KdsColumn, type KdsState } from "@chilli/ui/kds";
import { toast, useConfirm } from "@/components/ui";
import { useLocale, useMsg, type Catalog } from "@/lib/i18n";
import { canLeaveKiosk, kitchenMode, setKitchenFullScreen, useKitchenFullScreen } from "@/lib/kitchenMode";
import { useRole } from "@/lib/useRole";
import { useSignOut } from "@/lib/useSignOut";
import { api, ApiError, auth } from "@/lib/api";
import { cn } from "@/lib/cn";
import { printKotSlip, printOfflineKot } from "@/lib/printing";
import type { DiningTable, Kot, Order, OrderType } from "@/lib/types";
import { isWorking, minutesSince } from "@/lib/ticketAge";
import { splitTickets, useKitchenDisplayMinutes, useKitchenMode } from "@/lib/kitchenStatusMode";
import { isActiveTicket } from "@/lib/kitchenActive";
import { chime } from "@/lib/chime";
import { onKitchenChanged } from "@/lib/kitchenSignal";
import { getTaxConfig } from "@/lib/taxConfig";
import { useKitchenTarget } from "@/lib/kitchenTarget";
import { KitchenTicket } from "./_components/KitchenTicket";

type KotStatus = "pending" | "preparing" | "ready" | "served" | "cancelled";
interface TicketOrder { type: OrderType; where: string; kind?: string }
const TYPE_ICON: Record<OrderType, LucideIcon> = { indoor: Utensils, outdoor: Sun, takeaway: ShoppingBag, delivery: Bike };
const NEXT: Partial<Record<KotStatus, KotStatus>> = { pending: "preparing", preparing: "ready", ready: "served" };
const KDS_STATE: Record<string, KdsState> = { pending: "new", preparing: "prep", ready: "ready" };

const MSG = {
  title: { en: "Kitchen", hi: "रसोई", hinglish: "Kitchen" },
  loading: { en: "Loading…", hi: "लोड हो रहा है…", hinglish: "Load ho raha hai…" },
  updated: { en: "Updated {when}", hi: "अपडेट: {when}", hinglish: "Update: {when}" },
  justNow: { en: "just now", hi: "अभी", hinglish: "abhi" },
  secAgo: { en: "{n}s ago", hi: "{n} सेकंड पहले", hinglish: "{n}s pehle" },
  soundOn: { en: "Sound on", hi: "आवाज़ चालू", hinglish: "Sound on" },
  soundOff: { en: "Sound off", hi: "आवाज़ बंद", hinglish: "Sound off" },
  refresh: { en: "Refresh tickets", hi: "टिकट ताज़ा करें", hinglish: "Tickets refresh karein" },
  fullScreen: { en: "Full screen", hi: "फ़ुल स्क्रीन", hinglish: "Full screen" },
  exitFull: { en: "Exit full screen", hi: "फ़ुल स्क्रीन से बाहर", hinglish: "Full screen se bahar" },
  signOut: { en: "Sign out", hi: "साइन आउट", hinglish: "Sign out" },
  feedProblem: { en: "Ticket feed problem", hi: "टिकट फ़ीड में समस्या", hinglish: "Ticket feed mein problem" },
  loadingTickets: { en: "Loading tickets", hi: "टिकट लोड हो रहे हैं", hinglish: "Tickets load ho rahe hain" },
  colPending: { en: "Pending", hi: "नए", hinglish: "Naye" },
  colPreparing: { en: "Preparing", hi: "बन रहे हैं", hinglish: "Ban rahe hain" },
  colReady: { en: "Ready", hi: "तैयार", hinglish: "Taiyaar" },
  emptyTitle: { en: "No tickets yet", hi: "अभी कोई टिकट नहीं", hinglish: "Abhi koi ticket nahi" },
  emptyHint: { en: "When the cashier sends an order to the kitchen it appears here instantly.", hi: "कैशियर जैसे ही ऑर्डर रसोई में भेजेगा, वह यहाँ दिखेगा।", hinglish: "Cashier jaise hi order kitchen bhejega, yahan dikhega." },
  addOn: { en: "Add-on to earlier order", hi: "पिछले ऑर्डर में जोड़ा", hinglish: "Pichhle order mein add-on" },
  dismiss: { en: "Dismiss", hi: "हटाएँ", hinglish: "Hatayein" },
  dismissFail: { en: "Could not dismiss the ticket", hi: "टिकट हटाया नहीं जा सका", hinglish: "Ticket hata nahi paya" },
  earlier: { en: "Earlier tickets ({n})", hi: "पिछले टिकट ({n})", hinglish: "Pichhle tickets ({n})" },
  nothingEarlier: { en: "No earlier tickets.", hi: "कोई पिछला टिकट नहीं।", hinglish: "Koi pichhla ticket nahi." },
  autoHint: { en: "Tickets clear by themselves after {n} min.", hi: "टिकट {n} मिनट बाद अपने आप हट जाते हैं।", hinglish: "Tickets {n} min baad apne aap hat jaate hain." },
  startPrep: { en: "Start preparing", hi: "बनाना शुरू करें", hinglish: "Banana shuru karein" },
  markReady: { en: "Mark ready", hi: "तैयार करें", hinglish: "Taiyaar karein" },
  markServed: { en: "Mark served", hi: "परोसा गया", hinglish: "Parosa gaya" },
  served: { en: "Served ({n})", hi: "परोसे गए ({n})", hinglish: "Parose gaye ({n})" },
  nothingServed: { en: "Nothing served yet.", hi: "अभी कुछ परोसा नहीं गया।", hinglish: "Abhi kuch parosa nahi gaya." },
  retry: { en: "Retry", hi: "फिर कोशिश करें", hinglish: "Phir koshish karein" },
  print: { en: "Print KOT slip", hi: "KOT पर्ची छापें", hinglish: "KOT slip print karein" },
  cancel: { en: "Cancel ticket", hi: "टिकट रद्द करें", hinglish: "Ticket cancel karein" },
  order: { en: "Order", hi: "ऑर्डर", hinglish: "Order" },
  table: { en: "Table {n}", hi: "टेबल {n}", hinglish: "Table {n}" },
  takeaway: { en: "Takeaway", hi: "टेकअवे", hinglish: "Takeaway" },
  delivery: { en: "Delivery", hi: "डिलीवरी", hinglish: "Delivery" },
  outdoor: { en: "Outdoor", hi: "बाहर", hinglish: "Bahar" },
  dineIn: { en: "Dine-in", hi: "डाइन-इन", hinglish: "Dine-in" },
  indoor: { en: "Indoor", hi: "अंदर", hinglish: "Indoor" },
  waiting: { en: "Waiting {t}", hi: "{t} से इंतज़ार", hinglish: "{t} se wait" },
  late: { en: "Late", hi: "देर हो गई", hinglish: "Late" },
  gettingLate: { en: "Getting late", hi: "देर हो रही है", hinglish: "Late ho raha hai" },
  noServer: { en: "Cannot reach the server. Showing the last tickets received.", hi: "सर्वर से संपर्क नहीं हो पा रहा। आख़िरी मिले टिकट दिख रहे हैं।", hinglish: "Server se connect nahi ho raha. Aakhri mile tickets dikh rahe hain." },
} satisfies Catalog;

const REFRESH_MS = 10_000;
const SEEN_KEY = "pos.kds.seen";

const COLUMNS: { status: KotStatus; title: keyof typeof MSG }[] = [
  { status: "pending", title: "colPending" },
  { status: "preparing", title: "colPreparing" },
  { status: "ready", title: "colReady" },
];

const SOUND_KEY = "pos.kds.sound";
function readSeen(): Record<string, number> { try { return JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}"); } catch { return {}; } }
function writeSeen(m: Record<string, number>) { try { localStorage.setItem(SEEN_KEY, JSON.stringify(m)); } catch { /* ignore */ } }

export default function KitchenPage() {
  const router = useRouter();
  const confirm = useConfirm();
  const t = useMsg(MSG);
  const { locale } = useLocale();
  const [kots, setKots] = useState<Kot[] | null>(null);
  const [orders, setOrders] = useState<Map<string, Order>>(new Map());
  const [tables, setTables] = useState<Map<string, DiningTable>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const target = useKitchenTarget();
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [showServed, setShowServed] = useState(false);
  const kotOnly = useKitchenMode() === "kot_only"; // default: the ticket just arrives; nobody clicks, tickets clear by age (docs/KOT_ONLY_KITCHEN.md)
  const displayMin = useKitchenDisplayMinutes();
  const [showEarlier, setShowEarlier] = useState(false);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [spinning, setSpinning] = useState(false);
  const seenIds = useRef<Set<string> | null>(null); // ids present at the previous poll (null before first load)
  const [since, setSince] = useState<Record<string, number>>({});
  const tablesLoaded = useRef(false);
  const [announce, setAnnounce] = useState("");
  const role = useRole();
  const signOut = useSignOut();
  const mode = kitchenMode(role, useKitchenFullScreen());
  const kiosk = mode === "kiosk";
  const [sound, setSound] = useState(false);
  const soundRef = useRef(false);
  useEffect(() => { try { const v = localStorage.getItem(SOUND_KEY); const on = v === null ? kotOnly : v === "1"; soundRef.current = on; void Promise.resolve().then(() => setSound(on)); } catch { /* ignore */ } }, [kotOnly]); // KOT only: the beep is ON until someone turns it off
  function toggleSound() {
    const on = !sound; setSound(on); soundRef.current = on;
    try { localStorage.setItem(SOUND_KEY, on ? "1" : "0"); } catch { /* ignore */ }
    if (on) chime(); // also unlocks audio for later tickets
  }

  const modeCheck = useRef(0);
  const load = useCallback(async (manual = false) => {
    if (manual) setSpinning(true);
    try {
      if (manual || Date.now() - modeCheck.current > 30_000) { modeCheck.current = Date.now(); void api.me().catch(() => undefined); } // adopts the owner's kitchen mode (api.me)
      const [k, o] = await Promise.all([api.kots(), api.orders()]);
      if (!tablesLoaded.current || manual) { const t = await api.tables(); setTables(new Map(t.map((x) => [x.id, x]))); tablesLoaded.current = true; }
      const t0 = Date.now();
      const stored = readSeen();
      const map: Record<string, number> = {};
      for (const x of k) map[x.id] = x.created_at ? new Date(x.created_at).getTime() : stored[x.id] ?? t0;
      writeSeen(map); setSince(map);
      const ids = new Set(k.map((x) => x.id));
      if (seenIds.current) {
        const added = k.filter((x) => !seenIds.current!.has(x.id) && x.status === "pending");
        if (added.length) {
          setFresh((f) => new Set([...f, ...added.map((x) => x.id)]));
          if (soundRef.current) chime();
          setAnnounce(`New ticket ${added.map((x) => `#${x.number}`).join(", ")}`);
          setTimeout(() => setFresh((f) => { const n = new Set(f); added.forEach((x) => n.delete(x.id)); return n; }), 6000);
        }
      }
      seenIds.current = ids;
      setKots(k); setOrders(new Map(o.map((x) => [x.id, x]))); setError(null); setUpdatedAt(t0); setNow(t0);
    } catch (e) {
      setError(e instanceof ApiError ? (e.status === 0 ? t("noServer") : e.message) : "Failed to load tickets");
    } finally { if (manual) setSpinning(false); }
  }, [t]);

  useEffect(() => {
    if (!auth.token) { router.replace("/login"); return; }
    void Promise.resolve().then(() => load());
    const poll = setInterval(() => { if (!document.hidden) void load(); }, REFRESH_MS);
    const tick = setInterval(() => setNow(Date.now()), 5_000);
    const offBill = onKitchenChanged(() => void load()); // a bill was made at the counter: the ticket leaves the board now, not at the next poll
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => { offBill(); clearInterval(poll); clearInterval(tick); window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onFocus); };
  }, [load, router]);

  async function advance(k: Kot, to: KotStatus) {
    const prev = k.status;
    setBusy((b) => new Set(b).add(k.id));
    setKots((l) => l && l.map((x) => (x.id === k.id ? { ...x, status: to } : x)));
    try { await api.updateKot(k.id, to); if (to === "ready") toast.success(`Ticket #${k.number} is ready`); }
    catch (e) {
      setKots((l) => l && l.map((x) => (x.id === k.id ? { ...x, status: prev } : x)));
      toast.error(e instanceof ApiError ? e.message : "Could not update the ticket");
    } finally { setBusy((b) => { const n = new Set(b); n.delete(k.id); return n; }); void load(); }
  }

  /** Optional (never required): hide one ticket now. The server keeps it as a single completed flag (done_at); it moves to "Earlier tickets". */
  async function dismiss(k: Kot) {
    setBusy((b) => new Set(b).add(k.id));
    setKots((l) => l && l.map((x) => (x.id === k.id ? { ...x, status: "served", done_at: new Date().toISOString() } : x)));
    try { await api.doneKot(k.id); }
    catch (e) {
      setKots((l) => l && l.map((x) => (x.id === k.id ? k : x)));
      toast.error(e instanceof ApiError ? e.message : t("dismissFail"));
    } finally { setBusy((b) => { const n = new Set(b); n.delete(k.id); return n; }); void load(); }
  }

  async function printTicket(k: Kot) {
    try {
      if (navigator.onLine) await printKotSlip(k.id);
      else printOfflineKot({ ref: `KOT #${k.number}`, where: describe(k)?.where ?? "Order", at: k.created_at ?? new Date().toISOString(), lines: k.payload.map((l) => ({ qty: l.qty, label: l.item, note: l.note })) });
    } catch (e) { toast.error(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Could not print the ticket"); }
  }

  async function cancelTicket(k: Kot) {
    if (await confirm({ title: `Cancel ticket #${k.number}?`, description: "The kitchen will stop working on it. The order itself is not cancelled.", tone: "danger", confirmLabel: "Cancel ticket", cancelLabel: "Keep" })) await advance(k, "cancelled");
  }

  const tt = t;
  const describe = useCallback((k: Kot): TicketOrder | undefined => {
    const o = orders.get(k.order_id);
    if (!o) return undefined;
    const tb = o.table_id ? tables.get(o.table_id) : undefined;
    // A table order names the TABLE's area ("Table AC1" + "Indoor"), the same on every screen; the order's own type is never shown beside a table.
    const label = tb ? tt("table", { n: tb.label }) : o.table_id ? tt("table", { n: "" }).trim() : o.order_type === "takeaway" ? tt("takeaway") : o.order_type === "delivery" ? tt("delivery") : o.order_type === "outdoor" ? tt("outdoor") : tt("dineIn");
    const kind = tb ? (tb.area === "outdoor" ? tt("outdoor") : tt("indoor")) : undefined;
    return { type: tb ? tb.area : o.order_type, where: label, kind };
  }, [orders, tables, tt]);

  // The same rule as the Orders tile (lib/kitchenActive): a ticket whose order was billed or cancelled is off the live board (it waits under Served / Earlier).
  const boardKots = useMemo(() => (kots ? kots.map((k) => (!isActiveTicket(k, orders.get(k.order_id)) && k.status !== "served" && k.status !== "cancelled" && !k.done_at ? { ...k, status: "served", done_at: "ended" } : k)) : kots), [kots, orders]);
  const by = useMemo(() => {
    const m: Record<string, Kot[]> = { pending: [], preparing: [], ready: [], served: [] };
    // oldest first so the most urgent ticket is on top
    for (const k of [...(boardKots ?? [])].sort((a, b) => a.number - b.number)) m[k.status]?.push(k);
    return m;
  }, [boardKots]);
  // KOT only: newest first; a ticket leaves the live list by itself after `displayMin` minutes and at end of day (no click needed)
  const { live: openKots, earlier: earlierKots } = useMemo(() => splitTickets(boardKots ?? [], now, displayMin, getTaxConfig()?.timezone), [boardKots, now, displayMin]);
  const ago = updatedAt === null ? null : Math.max(0, Math.round((now - updatedAt) / 1000));

  const agoText = ago === null ? t("loading") : t("updated", { when: ago < 5 ? t("justNow") : t("secAgo", { n: ago }) });
  const addOnOf = (k: Kot) => (kots ?? []).some((x) => x.order_id === k.order_id && x.number < k.number && x.status !== "cancelled"); // a later KOT of the order, like the printed slip
  const itemsOf = (k: Kot) => k.payload.map((l, i) => ({ id: String(i), name: l.item, qty: l.qty, note: l.note ?? undefined, mods: l.modifiers, parts: l.components?.map((c) => ({ name: c.item, qty: c.qty })) }));
  const nextLabel = (st: KotStatus) => st === "pending" ? t("startPrep") : st === "preparing" ? t("markReady") : t("markServed");

  return (
    // Wall tablet (1024x768, 1280x800 landscape): header, then the three status columns filling the rest of the screen, each
    // scrolling inside itself, so Pending / Preparing / Ready are all visible without scrolling the page (UI_REVIEW BA-12).
    <div data-testid="kitchen" data-mode={mode} className={cn("flex min-w-0 flex-col", kiosk ? "min-h-dvh bg-bg md:h-dvh" : "md:h-[calc(100dvh-var(--topbar-h)-var(--tabbar-space)-2.25rem)] lg:h-[calc(100dvh-8.75rem)]")}>
      {/* One visible page title: in the shell the top bar already says "Kitchen", so the h1 is for screen readers only and the
          page starts with its controls. The kiosk has no top bar, so there the h1 is the visible title. */}
      <header className={cn("flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2", kiosk ? "justify-between px-3 py-2 sm:px-5 sm:py-3" : "mb-3 justify-end")}>
        <h1 className={cn("font-display font-extrabold tracking-tight text-fg", kiosk ? "text-3xl sm:text-4xl" : "sr-only")}>{t("title")}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn("text-fg-muted tnum", kiosk ? "text-base sm:text-lg" : "text-sm")} aria-hidden>{agoText}</span>
          {/* Phones: icon-only controls (the words stay as the accessible name) so the kiosk header is one row. */}
          <Button variant="secondary" size={kiosk ? "lg" : "md"} aria-pressed={sound} onClick={toggleSound} iconStart={sound ? <Volume2 aria-hidden /> : <VolumeX aria-hidden />}><span className="max-sm:sr-only">{sound ? t("soundOn") : t("soundOff")}</span></Button>
          <IconButton label={t("refresh")} variant="secondary" icon={<RefreshCw aria-hidden className={spinning ? "animate-spin" : undefined} />} onClick={() => void load(true)} />
          {/* Owner / manager: the board sits in the normal shell; "Full screen" turns this device into the kiosk, "Exit full screen" brings the shell back. */}
          {canLeaveKiosk(role) && (kiosk
            ? <Button variant="secondary" size="lg" iconStart={<Minimize2 aria-hidden />} onClick={() => setKitchenFullScreen(false)}><span className="max-sm:sr-only">{t("exitFull")}</span></Button>
            : <Button variant="secondary" iconStart={<Maximize2 aria-hidden />} onClick={() => setKitchenFullScreen(true)}><span className="max-sm:sr-only">{t("fullScreen")}</span></Button>)}
          {kiosk && <Button variant="ghost" size="lg" iconStart={<LogOut aria-hidden />} onClick={() => void signOut()}><span className="max-sm:sr-only">{t("signOut")}</span></Button>}
        </div>
      </header>
      <p role="status" className="sr-only">{announce}</p>
      {error && <div className="shrink-0 px-3 pb-3 sm:px-5"><Notice tone={kots ? "warning" : "danger"} title={t("feedProblem")} locale={locale as Locale} action={<Button size="sm" onClick={() => void load(true)}>{t("retry")}</Button>}>{error}</Notice></div>}

      {kots === null && !error ? (
        <div role="status" aria-label={t("loadingTickets")} className="grid gap-4 px-3 sm:px-5 md:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => <div key={i} className="space-y-3"><Skeleton height={32} width={160} /><Skeleton height={224} /><Skeleton height={176} /></div>)}
        </div>
      ) : (
        <>
          {kots && (kotOnly ? openKots.length === 0 : kots.length === 0) && <p className={cn("hidden shrink-0 pb-2 text-lg text-fg-muted md:block", kiosk && "px-3 sm:px-5")}><b className="text-fg">{t("emptyTitle")}.</b> {t("emptyHint")}</p>}
          {kotOnly ? (
          <div data-testid="kitchen-board" data-kitchen-mode="kot_only" aria-label={t("title")} role="region" className={cn("kitchen-board kitchen-board--kot min-h-0 md:flex-1", !kiosk && "rounded-2xl")}>
            <div className="kitchen-grid" data-testid="kitchen-open-tickets">
              {openKots.map((k) => {
                const o = describe(k);
                const Icon = o ? TYPE_ICON[o.type] : Utensils;
                return (
                  <div key={k.id} data-testid="kot-ticket">
                    <KitchenTicket number={k.number} where={o?.where ?? t("order")} kind={o?.kind} icon={<Icon aria-hidden className="size-6 shrink-0" />}
                      items={itemsOf(k)} minutes={minutesSince(since[k.id] ?? now, now) ?? 0} tracksLate={false} targetMin={target}
                      fresh={fresh.has(k.id)} busy={busy.has(k.id)} token={k.token_number} orderNote={k.order_note} addOn={addOnOf(k)} labelAddOn={t("addOn")}
                      labels={{ waiting: (w) => t("waiting", { t: w }), late: t("late"), gettingLate: t("gettingLate") }}
                      actions={<>
                        <IconButton label={`${t("print")} #${k.number}`} icon={<Printer aria-hidden />} onClick={() => void printTicket(k)} />
                        <IconButton label={`${t("dismiss")} #${k.number}`} icon={<X aria-hidden />} disabled={busy.has(k.id)} onClick={() => void dismiss(k)} />
                      </>} />
                  </div>
                );
              })}
            </div>
          </div>
          ) : (
          <div data-testid="kitchen-board" data-kitchen-mode="track" className={cn("kitchen-board min-h-0 md:flex-1", !kiosk && "overflow-hidden rounded-2xl")}>
          <KdsBoard label={t("title")}>
            {COLUMNS.map((c) => {
              const list = by[c.status];
              return (
                <KdsColumn key={c.status} title={t(c.title)} state={KDS_STATE[c.status]} count={list.length} locale={locale}>
                  {list.map((k) => {
                    const o = describe(k);
                    const Icon = o ? TYPE_ICON[o.type] : Utensils;
                    const status = k.status as KotStatus;
                    const next = NEXT[status];
                    return (
                      <div key={k.id} data-testid="kot-ticket">
                        <KitchenTicket number={k.number} where={o?.where ?? t("order")} kind={o?.kind} icon={<Icon aria-hidden className="size-6 shrink-0" />}
                          items={itemsOf(k)}
                          minutes={minutesSince(since[k.id] ?? now, now) ?? 0} tracksLate={isWorking(status)} targetMin={target}
                          fresh={fresh.has(k.id)} busy={busy.has(k.id)}
                          onAdvance={next ? () => void advance(k, next) : undefined} advanceLabel={nextLabel(status)}
                          labels={{ waiting: (w) => t("waiting", { t: w }), late: t("late"), gettingLate: t("gettingLate") }}
                          actions={<>
                            <IconButton label={`${t("print")} #${k.number}`} icon={<Printer aria-hidden />} onClick={() => void printTicket(k)} />
                            {(status === "pending" || status === "preparing") && <IconButton label={`${t("cancel")} #${k.number}`} icon={<X aria-hidden />} disabled={busy.has(k.id)} onClick={() => void cancelTicket(k)} />}
                          </>} />
                      </div>
                    );
                  })}
                </KdsColumn>
              );
            })}
          </KdsBoard>
          </div>
          )}

          {kots && (kotOnly ? openKots.length === 0 : kots.length === 0) && (
            <div className="px-3 pt-6 sm:px-5 md:hidden"><EmptyState title={t("emptyTitle")} description={t("emptyHint")} /></div>
          )}

          {kotOnly && (
            <section className={cn("shrink-0", kiosk ? "px-3 py-2 sm:px-5" : "pt-2")} aria-label={t("earlier", { n: earlierKots.length })} data-testid="earlier-tickets">
              <Button variant="ghost" onClick={() => setShowEarlier((v) => !v)} aria-expanded={showEarlier}>
                {t("earlier", { n: earlierKots.length })} <ChevronDown aria-hidden className={cn("size-4 transition-transform", showEarlier && "rotate-180")} />
              </Button>
              <span className="ml-2 text-sm text-fg-muted">{t("autoHint", { n: displayMin })}</span>
              {showEarlier && (earlierKots.length === 0 ? <p className="mt-2 text-sm text-fg-muted">{t("nothingEarlier")}</p> : (
                <ul className="mt-3 grid max-h-[30vh] gap-3 overflow-y-auto pb-2 sm:grid-cols-2 xl:grid-cols-4">
                  {earlierKots.slice(0, 40).map((k) => (
                    <li key={k.id} data-testid="earlier-ticket" className="flex items-start justify-between gap-2 rounded-xl border border-border bg-surface px-4 py-3 text-sm">
                      <div className="min-w-0">
                        <p className="font-display text-lg font-bold text-fg">#{k.number} <span className="text-sm font-medium text-fg-muted">{describe(k)?.where}</span></p>
                        <p className="truncate text-fg-muted">{k.payload.map((l) => `${l.qty}× ${l.item}${l.note ? ` (${l.note})` : ""}`).join(", ")}</p>
                      </div>
                      <IconButton label={`${t("print")} #${k.number}`} icon={<Printer aria-hidden />} onClick={() => void printTicket(k)} />
                    </li>
                  ))}
                </ul>
              ))}
            </section>
          )}
          {!kotOnly && <section className={cn("shrink-0", kiosk ? "px-3 py-2 sm:px-5" : "pt-2")} aria-label="Served tickets">
            <Button variant="ghost" onClick={() => setShowServed((s) => !s)} aria-expanded={showServed}>
              {t("served", { n: by.served.length })} <ChevronDown aria-hidden className={cn("size-4 transition-transform", showServed && "rotate-180")} />
            </Button>
            {showServed && (by.served.length === 0 ? <p className="mt-2 text-sm text-fg-muted">{t("nothingServed")}</p> : (
              <ul className="mt-3 grid max-h-[30vh] gap-3 overflow-y-auto pb-2 sm:grid-cols-2 xl:grid-cols-4">
                {by.served.slice(-12).reverse().map((k) => (
                  <li key={k.id} className="rounded-xl border border-border bg-surface px-4 py-3 text-sm opacity-80">
                    <p className="font-display text-lg font-bold text-fg">#{k.number} <span className="text-sm font-medium text-fg-muted">{describe(k)?.where}</span></p>
                    <p className="truncate text-fg-muted">{k.payload.map((l) => `${l.qty}× ${l.item}`).join(", ")}</p>
                  </li>
                ))}
              </ul>
            ))}
          </section>}
        </>
      )}
    </div>
  );
}
