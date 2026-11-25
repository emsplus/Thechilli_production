"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { CustomerSheet } from "@/components/CustomerSheet";
import { BillTabs, FoodImage } from "@/components/OrderUi";
import { cartTotal, NOTE_MAX, toNewOrder, validateDraft, type DraftProblem, type ServiceMode } from "@/lib/cart";
import { draftActions, useDraft } from "@/lib/draft";
import { useMenu } from "@/lib/menu";
import { formatMoney, mulDecimal } from "@/lib/money";
import { areaLabel } from "@/lib/areas";
import { api, mediaUrl } from "@/lib/api";
import { modifiersText } from "@/lib/modifiers";
import type { ActiveOffer } from "@/lib/types";
import { buildAddItemsOps, buildKotOps } from "@/lib/queue/engine";
import { currentOutletId } from "@/lib/api";
import { submit, useOnline } from "@/lib/sync";
import { computeTableStatus } from "@/lib/tableStatus";
import { fetchActiveOrders, useTableStatus } from "@/lib/tableStatusHook";
import { UnpaidBillCard } from "@/components/UnpaidBillCard";
import { engine } from "@/lib/sync";
import { peekToken, takeToken } from "@/lib/token";
import { useT, type Key } from "@/lib/i18n";
import type { CartLine } from "@/lib/cart";
import { allowedModes } from "@/lib/capabilities";
import { useProfile } from "@/lib/capsStore";

const PROBLEM_KEY: Record<DraftProblem, Key> = { no_items: "cart.problem.none", pick_table: "cart.problem.table", table_gone: "cart.problem.gone", type_not_allowed: "cart.problem.type" };
const MODES: { v: ServiceMode; l: Key }[] = [{ v: "dine_in", l: "tables.dinein" }, { v: "takeaway", l: "tables.takeaway" }, { v: "delivery", l: "tables.delivery" }];

/** Review and send: everything about the bill on one screen, one primary action ("Send to kitchen"). */
export default function Cart() {
  const router = useRouter();
  const t = useT();
  const online = useOnline();
  const { snap } = useMenu();
  const draft = useDraft();
  const { status: tstatus, unpaid } = useTableStatus();
  const modes = allowedModes(useProfile());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [unverified, setUnverified] = useState(false);
  const [removed, setRemoved] = useState<{ line: CartLine; index: number } | null>(null);
  const [noteFor, setNoteFor] = useState<{ key: string; text: string } | null>(null);
  const [orderNote, setOrderNote] = useState(false);
  const [custOpen, setCustOpen] = useState(false);
  const [offers, setOffers] = useState<ActiveOffer[]>([]);
  useEffect(() => { if (!online) return; let live = true; api.activeOffers().then((o) => { if (live) setOffers(o); }).catch(() => {}); return () => { live = false; }; }, [online]);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (undoTimer.current) clearTimeout(undoTimer.current); }, []);
  const tables = snap?.tables ?? [];
  const items = snap?.items ?? [];
  const cats = new Map((snap?.categories ?? []).map((c) => [c.id, c.name]));
  const problemCode = validateDraft(draft, tables, modes);
  const problem = problemCode ? t(PROBLEM_KEY[problemCode]) : null;
  const table = tables.find((x) => x.id === draft.table_id);
  const count = draft.lines.reduce((s, l) => s + l.quantity, 0);
  const total = cartTotal(draft.lines);

  /** "-" at quantity 1 removes the line, but never silently: the Undo bar keeps it recoverable for a few seconds. */
  function decrease(l: CartLine) {
    if (l.quantity > 1) { draftActions.setQty(l.key, l.quantity - 1); return; }
    const index = draft.lines.findIndex((x) => x.key === l.key);
    draftActions.setQty(l.key, 0);
    setRemoved({ line: l, index });
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setRemoved(null), 8000);
  }
  const undoBar = removed && (
    <div className="banner row between" role="status">
      <span>{t("cart.removed", { name: removed.line.name })}</span>
      <button className="btn small" onClick={() => { draftActions.restore(removed.line, removed.index); setRemoved(null); }}>{t("cart.undo")}</button>
    </div>
  );
  const takeaway = draft.mode === "takeaway" && !draft.add_to;
  // The table has a bill that is not paid yet and no open order: the server would refuse this order, so say so now and offer the way forward.
  const unpaidHere = !draft.add_to && draft.mode === "dine_in" && draft.table_id && !draft.table_ack && !tstatus[draft.table_id]?.orderRef ? unpaid[draft.table_id] : undefined;

  async function send() {
    if (busy || problem) return; // busy guard + queue dedupe_key = no duplicate KOT on double tap
    setBusy(true); setErr(null);
    try {
      // One open order per table: re-check the server right now (cached list if offline). If the table has an open order by now
      // (taken on another device, by another waiter or at the counter), these items are ADDED to it, never a second order.
      let joinRef: string | null = null;
      if (!draft.add_to && draft.mode === "dine_in" && draft.table_id && !draft.table_ack) {
        let active = null as Awaited<ReturnType<typeof fetchActiveOrders>> | null;
        try { active = await fetchActiveOrders(); } catch { try { active = (JSON.parse(localStorage.getItem(`waiter.tablestatus.${currentOutletId() ?? "default"}`) ?? "null") as { orders: Awaited<ReturnType<typeof fetchActiveOrders>> } | null)?.orders ?? null; } catch { active = null; } setUnverified(true); }
        const info = active ? computeTableStatus(active, await engine.list())[draft.table_id] : undefined;
        if (info?.state === "clash") { setErr(t("cart.tableClash", { name: table?.label ?? "" })); setBusy(false); return; }
        if (info && info.state !== "free" && info.orderRef) joinRef = info.orderRef;
      }
      const token = takeaway ? takeToken() : null;  // local counter; the server allocates the official token_number when it receives the order
      const into = draft.add_to ?? joinRef;
      let ops = into
        ? buildAddItemsOps(into, draft.client_uuid, toNewOrder(draft, tables).lines)
        : buildKotOps(toNewOrder(draft, tables), draft.mode === "dine_in" ? table?.label : null);
      if (token) ops = ops.map((o) => (o.op.type === "create_order" ? { ...o, label: `New order · Token #${token}` } : o));
      await submit(ops); // resolves when durably queued, NOT when confirmed
      // Takeaway/delivery counters stay on the menu for the next customer; dine-in goes to the orders list.
      const counter = draft.mode !== "dine_in" && !into;
      draftActions.reset(token ? t("cart.savedToken", { n: token }) : counter ? t("cart.saved") : joinRef ? t("cart.joined", { name: table?.label ?? "" }) : undefined);
      router.replace(counter ? "/menu" : "/orders");
    } catch (e) {
      setErr(t("cart.saveFailed", { error: e instanceof Error ? e.message : "" }));
      setBusy(false);
    }
  }

  if (!draft.lines.length) {
    return (
      <AppShell title={t("cart.title")}>
        <BillTabs tables={tables} />
        {undoBar}
        <div className="empty">
          <svg viewBox="0 0 24 24" className="empty-ico" aria-hidden><path d="M6 7h12l-1 13H7z" /><path d="M9 7a3 3 0 0 1 6 0" /></svg>
          <strong>{t("cart.empty")}</strong>
          <p className="muted">Tap dishes on the menu to add them to this bill.</p>
          <Link className="btn primary" href="/menu">{t("cart.browse")}</Link>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell title={t("cart.confirmTitle")}>
      <BillTabs tables={tables} />
      {!draft.add_to && modes.length < 2 ? (
        <div className="facts card"><div className="fact"><span className="muted">{t("cart.orderType")}</span><strong>{t(MODES.find((m) => m.v === modes[0])!.l)}</strong></div></div>
      ) : !draft.add_to ? (
        <div className="seg" role="radiogroup" aria-label={t("cart.orderType")}>
          {MODES.filter((m) => modes.includes(m.v)).map((m) => <button key={m.v} type="button" role="radio" aria-checked={draft.mode === m.v} onClick={() => draftActions.setMode(m.v)}>{t(m.l)}</button>)}
        </div>
      ) : <p className="banner">{table ? t("cart.addToTable", { name: table.label }) : t("cart.addToNote")}</p>}
      <div className="facts card">
        {draft.mode === "dine_in" && !draft.add_to && (
          <div className="fact">
            <span className="muted">Table</span>
            {table ? <strong>{table.label}<span className="muted small"> · {areaLabel(table.area)}</span></strong> : <strong className="warn-text">{t("cart.noTable")}</strong>}
            <Link className="btn small" href="/tables" onClick={() => draftActions.markRetarget()}>{table ? "Change" : "Pick table"}</Link>
          </div>
        )}
        {draft.add_to && table && (
          <div className="fact">
            <span className="muted">Table</span>
            <strong>{table.label}<span className="muted small"> · open order</span></strong>
            <Link className="btn small" href="/tables" onClick={() => draftActions.markRetarget()}>Change</Link>
          </div>
        )}
        {takeaway && <div className="fact"><span className="muted">Token</span><strong>Counter token #{peekToken()}</strong></div>}
        {!draft.add_to && (
          <div className="fact">
            <span className="muted">Customer</span>
            {draft.customer ? <strong className="clip">{draft.customer.name}</strong> : <span className="muted">Not added</span>}
            {draft.customer
              ? <button className="btn small" onClick={() => draftActions.setCustomer(null)} aria-label="Remove customer">Remove</button>
              : <button className="btn small" onClick={() => setCustOpen(true)}>Add</button>}
          </div>
        )}
      </div>
      {undoBar}
      <h2 className="sec">{count} item{count === 1 ? "" : "s"}</h2>
      <ul className="lines">
        {draft.lines.map((l) => {
          const item = items.find((i) => i.id === l.item_id);
          return (
            <li key={l.key} className="line">
              <FoodImage src={mediaUrl(item?.thumb_url ?? item?.image_url)} name={l.name} category={item ? cats.get(item.category_id) : undefined} thumb />
              <div className="grow">
                <div className="line-name">{l.name}{l.variant_name && <span className="muted"> · {l.variant_name}</span>}</div>
                {!!l.modifiers?.length && <div className="line-mods">{modifiersText(l.modifiers)}</div>}
                {item?.sold_out && <div className="small warn-text" role="status">Sold out today. Remove it, the kitchen cannot take it.</div>}
                <div className="small muted money">{formatMoney(l.unit_price)} each</div>
                {noteFor?.key !== l.key && <button className="linkbtn" onClick={() => setNoteFor({ key: l.key, text: l.note })}>{l.note ? t("cart.lineNote", { text: l.note }) : "+ Note"}</button>}
              </div>
              <div className="line-right">
                <strong className="money">{formatMoney(mulDecimal(l.unit_price, l.quantity))}</strong>
                <div className="stepper" role="group" aria-label={t("cart.qtyAria", { name: l.name })}>
                  <button type="button" aria-label={l.quantity === 1 ? t("cart.removeAria", { name: l.name }) : t("cart.dec")} onClick={() => decrease(l)}>−</button>
                  <output>{l.quantity}</output>
                  <button type="button" aria-label={t("cart.inc")} onClick={() => draftActions.setQty(l.key, l.quantity + 1)}>+</button>
                </div>
              </div>
              {noteFor?.key === l.key && (
                <div className="noteedit">
                  <input className="input slim" autoFocus maxLength={NOTE_MAX} value={noteFor.text} placeholder="e.g. no onion, less spicy" aria-label={`Note for ${l.name}`} onChange={(e) => setNoteFor({ key: l.key, text: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") { draftActions.setLineNote(l.key, noteFor.text); setNoteFor(null); } }} />
                  <button className="btn small primary" onClick={() => { draftActions.setLineNote(l.key, noteFor.text); setNoteFor(null); }}>Save</button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <Link className="btn block ghost" href="/menu">+ Add more dishes</Link>
      {!draft.add_to && (orderNote || draft.note ? (
        <label className="field" style={{ marginTop: 16 }}><span>{t("cart.orderNote")}</span>
          <textarea className="input" maxLength={NOTE_MAX} rows={2} value={draft.note ?? ""} placeholder={t("cart.orderNotePh")} onChange={(e) => draftActions.setNote(e.target.value)} />
        </label>
      ) : <button className="linkbtn" style={{ marginTop: 12 }} onClick={() => setOrderNote(true)}>+ Note for the whole order</button>)}
      <div className="totals">
        <span>{t("cart.subtotal")}</span><strong className="money">{formatMoney(total)}</strong>
      </div>
      {/* Offers running now (GET /offers/active). The bill applies them by itself; the waiter only sees that one will. */}
      {offers.map((o) => <div key={o.id} className="offer-line"><span>{o.label}</span><span>applied at billing</span></div>)}
      {problem && <div className="banner" role="alert">{problem}</div>}
      {unpaidHere && <UnpaidBillCard total={unpaidHere.total} orderId={unpaidHere.order_id} onStartNew={() => draftActions.setTable(draft.table_id, true)} />}
      {unverified && !err && <div className="banner" role="status">{t("cart.tableUnverified")}</div>}
      {err && <div className="banner err" role="alert">{err}</div>}
      <div className="sendbar">
        <button className="btn primary block" onClick={() => void send()} disabled={busy || !!problem || !!unpaidHere}>
          {busy ? t("send.saving") : <>{t("send.kot")}<span className="sb-total">{formatMoney(total)}</span></>}
        </button>
        <p className="small muted center">{online ? "Creates the order and the kitchen ticket (KOT)." : "Offline: saved on this phone and sent automatically when the connection returns."}</p>
      </div>
      {custOpen && <CustomerSheet onPick={(c) => { draftActions.setCustomer(c); setCustOpen(false); }} onClose={() => setCustOpen(false)} />}
    </AppShell>
  );
}
