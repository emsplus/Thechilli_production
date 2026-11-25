"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AppShell } from "@/components/AppShell";
import { LiveStamp } from "@/components/LiveStamp";
import { draftActions, useBills, useDraft } from "@/lib/draft";
import { billLabel } from "@/lib/bills";
import { useMenu } from "@/lib/menu";
import { areaLabel } from "@/lib/areas";
import { useT, type Key } from "@/lib/i18n";
import { orderHref } from "@/lib/routes";
import { myTableIds, type TableInfo } from "@/lib/tableStatus";
import { useAssignedTables, useTableStatus } from "@/lib/tableStatusHook";
import { reservationTime } from "@/lib/reservationHint";
import { allowedModes, reservationsOn, showTables } from "@/lib/capabilities";
import { useProfile } from "@/lib/capsStore";
import { useDialogFocus } from "@/lib/dialogFocus";
import { UnpaidBillCard } from "@/components/UnpaidBillCard";
import type { UnpaidBill } from "@/lib/liveSync";

const STATE_KEY: Record<string, Key> = { billed: "tables.billDue", free: "tables.free", mine: "tables.mine", taken: "tables.taken", queued: "tables.queued", clash: "tables.clash" };

/** The sticky "what do you want to do with this table" card. Not modal (the floor stays usable), but Esc closes it and the focus goes back to the tile. */
function TableSheet({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, onClose, { trap: false });
  return <div className="card tablesheet" role="dialog" aria-label={label} tabIndex={-1} ref={ref}>{children}</div>;
}

/** Floor view. Occupancy comes from the server's open orders, so a table another waiter has taken is shown as such. */
export default function Tables() {
  const router = useRouter();
  const t = useT();
  const profile = useProfile();
  const modes = allowedModes(profile);
  // A business without tables (kitchen) never lands here: a stale link or bookmark goes to the new order screen.
  useEffect(() => { if (!showTables(profile)) router.replace("/menu"); }, [profile, router]);
  const { snap, loading } = useMenu();
  const draft = useDraft();
  const bills = useBills();
  const { status, reserved, unpaid, live } = useTableStatus();
  const assigned = useAssignedTables();
  const [tab, setTab] = useState<"all" | "mine">("all");
  const [full, setFull] = useState(false);
  const [sheet, setSheet] = useState<{ id: string; label: string; info: TableInfo; carry: boolean; bill?: UnpaidBill } | null>(null);
  const tables = (snap?.tables ?? []).filter((x) => x.is_active);
  const shown = tab === "mine" ? tables.filter((x) => myTableIds(tables.map((y) => y.id), assigned ?? null, status).includes(x.id)) : tables;
  const areas = [...new Set(shown.map((x) => x.area))];

  function pick(id: string, label: string) {
    setFull(false);
    const info = status[id];
    // Items first, table afterwards (or cart "Change"): the bill's items go to this table, and on to the cart to send.
    // That never opens another bill, so the 6-bill limit cannot block it.
    const carry = draftActions.carriesTo(id);
    // My own open order and nothing in the cart to bring along: just open it (Add items is on the order screen).
    if (info?.state === "mine" && !carry && info.orderId) { router.push(orderHref(info.orderId)); return; }
    if (info && info.state !== "free") { setSheet({ id, label, info, carry }); return; }
    // A bill made and not paid yet: the server refuses a new order here. Say so, with the two ways forward (never a silent block).
    if (!info && unpaid[id]) { setSheet({ id, label, info: { state: "free", count: 0 }, carry, bill: unpaid[id] }); return; }
    if (!draftActions.startFor({ table: id })) { setFull(true); return; }
    router.push(carry ? "/cart" : "/menu");
  }
  const count = draft.lines.reduce((n, l) => n + l.quantity, 0);
  const mode = (m: "dine_in" | "takeaway" | "delivery") => {
    setFull(false);
    if (m === "dine_in") { draftActions.setMode("dine_in"); return; }
    if (!draftActions.startFor({ mode: m })) { setFull(true); return; }
    router.push("/menu");
  };
  const sheetKey: Record<string, Key> = { taken: "tables.sheetTaken", mine: "tables.sheetMine", queued: "tables.sheetQueued", clash: "tables.sheetClash" };

  return (
    <AppShell title={t("tables.title")}>
      {/* This screen IS dine-in (the floor); Takeaway / Delivery jump straight to the menu with a bill of that type. */}
      <div className="seg" role="group" aria-label="Order type">
        <button type="button" aria-pressed={true} onClick={() => mode("dine_in")}>{t("tables.dinein")}</button>
        {modes.includes("takeaway") && <button type="button" aria-pressed={false} onClick={() => mode("takeaway")}>{t("tables.takeaway")}</button>}
        {modes.includes("delivery") && <button type="button" aria-pressed={false} onClick={() => mode("delivery")}>{t("tables.delivery")}</button>}
      </div>
      {full && (
        // Only when a NEW bill was really needed: say which bills are open, one tap opens each.
        <div className="banner" role="status">
          <div>{bills.bills.length} bills are already open on this phone. Send or close one first:</div>
          <div className="row" style={{ flexWrap: "wrap", marginTop: 8 }}>
            {bills.bills.map((b) => <button key={b.client_uuid} type="button" className="btn small" onClick={() => { draftActions.switchBill(b.client_uuid); setFull(false); router.push("/cart"); }}>{billLabel(b, tables)} · {b.lines.reduce((n, l) => n + l.quantity, 0)} items</button>)}
          </div>
        </div>
      )}
      <div className="chips" role="group" aria-label={t("tables.title")}>
        <button className="chip" aria-pressed={tab === "all"} onClick={() => setTab("all")}>{t("tables.tab.all")}</button>
        <button className="chip" aria-pressed={tab === "mine"} onClick={() => setTab("mine")}>{t("tables.tab.mine")}</button>
      </div>
      {!live && <div className="banner" role="status">{t("tables.stale")}</div>}
      <LiveStamp />
      {tab === "mine" && assigned === null && <p className="small muted">{t("tables.noAssign")}</p>}
      {sheet && (
        <TableSheet label={sheet.label} onClose={() => setSheet(null)}>
          {sheet.bill ? (
            <>
              <p style={{ marginTop: 0 }}><strong>{t("tables.sheetBilled", { name: sheet.label })}</strong></p>
              <UnpaidBillCard total={sheet.bill.total} orderId={sheet.bill.order_id}
                onStartNew={() => { if (draftActions.startFor({ table: sheet.id, ack: true })) router.push(sheet.carry ? "/cart" : "/menu"); else { setSheet(null); setFull(true); } }}>
                <button className="btn" onClick={() => router.push(orderHref(sheet.bill!.order_id))}>{t("tables.openOrder")}</button>
                <button className="btn" onClick={() => setSheet(null)}>{sheet.carry ? "Cancel" : t("tables.close")}</button>
              </UnpaidBillCard>
            </>
          ) : (<>
          <p><strong>{t(sheetKey[sheet.info.state], { name: sheet.label })}</strong></p>
          <div className="row" style={{ flexWrap: "wrap" }}>
            {/* The cart's items (taken before the table was picked) join the table's open order: one order per table. */}
            {sheet.carry && sheet.info.state !== "clash" && sheet.info.orderRef && <button className="btn primary" onClick={() => { const r = draftActions.joinOrder(sheet.info.orderRef!, sheet.id); setSheet(null); if (r === "full") setFull(true); else router.push("/cart"); }}>{t("tables.carryHere", { n: count, name: sheet.label })}</button>}
            <button className={sheet.carry && sheet.info.state !== "clash" ? "btn" : "btn primary"} onClick={() => router.push(orderHref(sheet.info.orderId!))}>{t("tables.openOrder")}</button>
            {!sheet.carry && sheet.info.state !== "clash" && sheet.info.state !== "queued" && sheet.info.orderRef && <button className="btn" onClick={() => { if (draftActions.addTo(sheet.info.orderRef!, sheet.id)) router.push("/menu"); else { setSheet(null); setFull(true); } }}>{t("tables.addItems")}</button>}
            {sheet.info.state === "taken" && <button className="btn" onClick={() => { if (draftActions.startFor({ table: sheet.id, ack: true })) router.push(sheet.carry ? "/cart" : "/menu"); else { setSheet(null); setFull(true); } }}>{t("tables.separate")}</button>}
            <button className="btn" onClick={() => setSheet(null)}>{sheet.carry ? "Cancel" : t("tables.close")}</button>
          </div>
          </>)}
        </TableSheet>
      )}
      {loading && <div className="grid" role="status" aria-label={t("tables.loading")}>{Array.from({ length: 6 }, (_, i) => <div key={i} className="tile dish skel" style={{ minHeight: 96 }} />)}</div>}
      {!loading && !tables.length && <p className="muted">{t("tables.none")}</p>}
      {!loading && tab === "mine" && tables.length > 0 && !shown.length && <p className="muted">{t("tables.mineEmpty")}</p>}
      {areas.map((a) => (
        <section key={a} aria-label={`${areaLabel(a)} tables`}>
          <h2 className="sec">{areaLabel(a)}</h2>
          <div className="grid">
            {shown.filter((tb) => tb.area === a).map((tb) => {
              const st = status[tb.id]?.state ?? (unpaid[tb.id] ? "billed" : "free");
              // Booked within the hour: still free to seat (same one tap), the tile just says for whom.
              const rsv = st === "free" && reservationsOn(profile) ? reserved[tb.id] : undefined;
              return (
                <button key={tb.id} className="tile" data-state={rsv ? "reserved" : st} aria-pressed={draft.mode === "dine_in" && draft.table_id === tb.id}
                  onClick={() => pick(tb.id, tb.label)}>
                  <span className="tile-label">{tb.label}</span><span className="small muted">{t("tables.seats", { n: tb.seats })}</span>
                  <span className="tile-state"><i aria-hidden />{rsv ? "Reserved" : t(STATE_KEY[st])}{assigned?.has(tb.id) ? " ★" : ""}</span>
                  {rsv && <span className="tile-hint">{reservationTime(rsv.starts_at)} · {rsv.guest_name}</span>}
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </AppShell>
  );
}
