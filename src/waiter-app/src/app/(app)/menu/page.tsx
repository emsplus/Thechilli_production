"use client";
import Link from "next/link";
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { ItemSheet } from "@/components/ItemSheet";
import { BillTabs, CartBar, DishCard } from "@/components/OrderUi";
import { billLabel } from "@/lib/bills";
import { cartTotal, makeLine, type CartLine } from "@/lib/cart";
import { groupsFor, needsChoice } from "@/lib/modifiers";
import { draftActions, useDraft } from "@/lib/draft";
import { useMenu } from "@/lib/menu";
import type { MenuItem } from "@/lib/types";
import { voiceProvider } from "@/lib/voice";
import { VoiceSheet } from "@/components/VoiceSheet";
import { searchItems } from "@/lib/aliases";
import { useAliases } from "@/lib/aliasStore";
import { useT, type Key } from "@/lib/i18n";
import { allowedModes, showTables, type ServiceMode } from "@/lib/capabilities";
import { useProfile } from "@/lib/capsStore";

const MODE_LABEL: Record<ServiceMode, Key> = { dine_in: "tables.dinein", takeaway: "tables.takeaway", delivery: "tables.delivery" };

/**
 * Order taking, as on the original Karahi counter on a phone: category chips with counts, photo cards (tap = add one,
 * - n + on the card), bill tabs, and a sticky bar with the count and total that opens the review.
 */
export default function MenuPage() {
  const t = useT();
  const aliases = useAliases();
  const { snap, loading } = useMenu();
  const draft = useDraft();
  const [cat, setCat] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const dq = useDeferredValue(q);
  const [sheet, setSheet] = useState<{ item: MenuItem; mode: "pick" | "detail" } | null>(null);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const closeVoice = useCallback(() => setVoiceOpen(false), []);
  // "done" on the voice sheet added dishes: a toast with Undo for 8 seconds (nothing is placed or sent)
  const [voiceAdded, setVoiceAdded] = useState<{ lines: CartLine[]; n: number; check: string[] } | null>(null);
  useEffect(() => { if (!voiceAdded) return; const id = setTimeout(() => setVoiceAdded(null), 8000); return () => clearTimeout(id); }, [voiceAdded]);
  const closeSheet = useCallback(() => setSheet(null), []);
  // The confirmation floats over the menu (never in the flow, so the grid does not jump under a finger) and goes after 5 s.
  useEffect(() => { if (!draft.flash) return; const h = setTimeout(() => draftActions.clearFlash(), 5000); return () => clearTimeout(h); }, [draft.flash]);

  const active = useMemo(() => (snap?.items ?? []).filter((i) => i.is_active), [snap]);
  const cats = useMemo(() => [...(snap?.categories ?? [])].filter((c) => c.is_active).sort((a, b) => a.sort_order - b.sort_order), [snap]);
  const catName = useMemo(() => new Map(cats.map((c) => [c.id, c.name])), [cats]);
  const counts = useMemo(() => { const m = new Map<string, number>(); for (const i of active) m.set(i.category_id, (m.get(i.category_id) ?? 0) + 1); return m; }, [active]);
  // Search also matches Hindi/Hinglish (Devanagari, sound-alike spellings, learnt aliases); browsing filters by category.
  const items = useMemo(() => (dq.trim() ? searchItems(active, dq, aliases) : active.filter((i) => !cat || i.category_id === cat)), [active, cat, dq, aliases]);
  const qtyByItem = useMemo(() => { const m = new Map<string, number>(); for (const l of draft.lines) m.set(l.item_id, (m.get(l.item_id) ?? 0) + l.quantity); return m; }, [draft.lines]);

  const profile = useProfile();
  const floor = showTables(profile); // false for a cloud / hotel kitchen: no table picker, the order type is chosen here
  const modes = allowedModes(profile);
  const tables = useMemo(() => snap?.tables ?? [], [snap]);
  const table = tables.find((x) => x.id === draft.table_id);
  const count = draft.lines.reduce((s, l) => s + l.quantity, 0);
  const label = billLabel(draft, tables);

  // One tap adds one, as on the original counter. Dishes with modifier groups add with their defaults (no extra tap); only a
  // required group without a default opens the sheet, because there is nothing sensible to add without asking.
  const onPick = useCallback((item: MenuItem) => {
    if (item.variants.length || needsChoice(groupsFor(item))) setSheet({ item, mode: "pick" });
    else draftActions.add(makeLine(item, null, 1, ""));
  }, []);
  const onDetail = useCallback((item: MenuItem) => setSheet({ item, mode: "detail" }), []);

  return (
    <AppShell title={floor ? t("menu.title") : t("nav.newOrder")}>
      {draft.flash && (
        <div className="banner ok row between flashtoast" role="status">
          <span>{draft.flash}</span>
          <button className="btn small" onClick={() => draftActions.clearFlash()}>OK</button>
        </div>
      )}
      <BillTabs tables={tables} />
      {!floor && modes.length > 1 && !draft.add_to && (
        <div className="seg" role="radiogroup" aria-label={t("cart.orderType")}>
          {modes.map((m) => <button key={m} type="button" role="radio" aria-checked={draft.mode === m} onClick={() => draftActions.setMode(m)}>{t(MODE_LABEL[m])}</button>)}
        </div>
      )}
      {(draft.add_to || (floor && draft.mode === "dine_in" && !table)) && (
        <div className="forline">
          {draft.add_to ? <strong>{t("menu.addingTo")}</strong> : <Link className="chiplink warn" href="/tables">{t("menu.pickTable")}</Link>}
          {!draft.add_to && <span className="small muted">or switch this bill to Takeaway in the review</span>}
        </div>
      )}
      <div className="searchrow">
        <div className="search">
          <svg viewBox="0 0 24 24" aria-hidden><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
          <input type="search" aria-label={t("menu.searchAria")} placeholder={t("menu.search")} value={q} onChange={(e) => setQ(e.target.value)} />
          {q && <button type="button" className="clear" aria-label="Clear search" onClick={() => setQ("")}>×</button>}
        </div>
        {voiceProvider && (
          <button className="iconbtn mic-btn" aria-label={t("voice.micAria")} onClick={() => setVoiceOpen(true)}>
            <svg viewBox="0 0 24 24" aria-hidden><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
          </button>
        )}
      </div>
      {!dq && cats.length > 0 && (
        <div className="chips" role="group" aria-label="Categories">
          <button className="chip" aria-pressed={cat === null} onClick={() => setCat(null)}>{t("menu.all")}<span className="cnt">{active.length}</span></button>
          {cats.map((c) => <button key={c.id} className="chip" aria-pressed={cat === c.id} onClick={() => setCat(c.id)}>{c.name}<span className="cnt">{counts.get(c.id) ?? 0}</span></button>)}
        </div>
      )}
      {loading && !snap && (
        <div className="dishgrid" role="status" aria-label={t("menu.loading")}>{Array.from({ length: 6 }, (_, i) => <div key={i} className="dish skel" />)}</div>
      )}
      {!loading && !snap && (
        <div className="empty">
          <strong>Menu not downloaded yet</strong>
          <p className="muted">This device has never loaded the menu. Connect to the internet once and it is kept for offline use.</p>
        </div>
      )}
      {snap && !items.length && <div className="empty"><strong>{dq ? t("menu.none") : "Nothing in this category"}</strong><p className="muted">{dq ? "Try another spelling, or say it with the mic." : "Pick another category."}</p></div>}
      <ul className="dishgrid">
        {items.map((i) => (
          <li key={i.id}><DishCard item={i} category={catName.get(i.category_id)} qty={qtyByItem.get(i.id) ?? 0} onPick={onPick} onDetail={onDetail} /></li>
        ))}
      </ul>
      <CartBar count={count} total={cartTotal(draft.lines)} label={label} />
      {voiceOpen && <VoiceSheet onClose={closeVoice} onAdded={setVoiceAdded} />}
      {voiceAdded && (
        <div className="banner ok row between flashtoast" role="status" data-testid="voice-added">
          <span>{t("voice.done.added", { n: voiceAdded.n })}{voiceAdded.check.length ? `. ${t("voice.done.toCheck", { k: voiceAdded.check.length, names: voiceAdded.check.join(", ") })}` : ""}</span>
          <button className="btn small" onClick={() => { draftActions.unadd(voiceAdded.lines); setVoiceAdded(null); }}>{t("voice.done.undo")}</button>
        </div>
      )}
      {sheet && <ItemSheet item={sheet.item} mode={sheet.mode} category={catName.get(sheet.item.category_id)} onAdd={draftActions.add} onClose={closeSheet} />}
    </AppShell>
  );
}
