"use client";
import { modifiersText } from "@/lib/modifiers";
import type { BillPreview } from "@/lib/types";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useOrderId } from "@/lib/routes";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { LiveStamp } from "@/components/LiveStamp";
import { StatusPill } from "@/components/StatusPill";
import { api, ApiError } from "@/lib/api";
import { draftActions } from "@/lib/draft";
import { formatMoney, mulDecimal } from "@/lib/money";
import { orderSyncState } from "@/lib/queue/engine";
import { engine, retryNow, submit, useQueue, useOnline } from "@/lib/sync";
import { billRequestState, cancelState, markBillRequested, unsentLines, wasBillRequested } from "@/lib/orderOps";
import { cachedMe } from "@/lib/session";
import { useTableStatus } from "@/lib/tableStatusHook";
import { NOT_AVAILABLE_CODE } from "@/lib/capabilities";
import { useKitchenMode } from "@/lib/capsStore";
import { useServerOrders } from "@/lib/serverOrders";
import { useT } from "@/lib/i18n";
import type { Kot, ServerOrder } from "@/lib/types";
import { useMenu } from "@/lib/menu";
import { entryLabel, entryTotal } from "@/lib/orderEntries";
import { lineTitle, variantNameOf } from "@/lib/lineNames";
import { UnpaidBillCard } from "@/components/UnpaidBillCard";
import { TABLE_HAS_OPEN_ORDER } from "@/lib/queue/engine";

export default function OrderDetailClient() {
  const id = useOrderId();
  const router = useRouter();
  const t = useT();
  const ops = useQueue();
  const online = useOnline();
  const { snap } = useMenu();
  const { status: tableStatus, at: liveAt } = useTableStatus();
  const { orders: active } = useServerOrders("open,sent_to_kitchen");
  const [server, setServer] = useState<ServerOrder | null>(null);
  const [kots, setKots] = useState<Kot[]>([]);
  const kotOnly = useKitchenMode() === "kot_only"; // default: "Sent to kitchen", no Preparing / Ready / Served
  const [note, setNote] = useState<string | null>(null);
  const [askCancel, setAskCancel] = useState(false);
  const [panel, setPanel] = useState<"move" | "merge" | null>(null);
  const local = ops.filter((o) => o.order_ref === id || (o.result?.order_id === id));
  const ref = local[0]?.order_ref ?? server?.client_uuid ?? id;
  const state = local.length ? orderSyncState(local) : null;
  const serverId = state?.serverOrderId ?? (local.length ? null : id);

  useEffect(() => {
    if (!serverId) return;
    let live = true;
    const load = async () => {
      try {
        const o = await api.order(serverId);
        const k = (await api.kots()).filter((x) => x.order_id === serverId);
        if (live) { setServer(o); setKots(k); }
      } catch { /* offline: keep what we have */ }
    };
    void load();
    return () => { live = false; };
    // liveAt: the shared live poller (10 s while visible, at once on resume/focus) ticked, so a change made on another device
    // or at the counter (items added, KOT status, bill) shows here too.
  }, [serverId, state?.order, state?.kot, liveAt]);

  const create = local.find((o) => o.op.type === "create_order");
  const created = create?.op.type === "create_order" ? create.op.order : null;
  const conflicts = local.flatMap((o) => o.conflicts ?? []);
  const billed = server?.status === "billed" || server?.status === "cancelled";
  const tableId = server?.table_id ?? created?.table_id ?? null;
  const tableLabel = snap?.tables.find((x) => x.id === tableId)?.label;
  const serverToken = server?.token_number ?? (typeof create?.result?.token_number === "number" ? create.result.token_number : null);
  const token = serverToken ?? created?.token ?? null;
  const orderNote = server?.note ?? created?.note ?? null;
  const itemName = (itemId: string) => snap?.items.find((x) => x.id === itemId)?.name ?? t("order.itemFallback");
  // Name with its option wherever a line is named: from the line's variant id (the order stores only the id), the menu names it
  const lineName = (itemId: string, name: string, variantId: string | null | undefined, known?: string | null) => lineTitle(name, variantNameOf(snap?.items, itemId, variantId, known));

  const bill = billRequestState(local, server?.bill_requested_at ?? (wasBillRequested(ref) ? "earlier" : null));
  useEffect(() => { if (bill.state === "done") markBillRequested(ref); }, [bill.state, ref]);
  const cancel = cancelState(local);
  const unsent = unsentLines(local);
  const kotSent = kots.length > 0 || local.some((o) => o.op.type === "send_kot" && o.status === "synced");
  const perms = cachedMe()?.permissions;
  // Offers on the total line: the bill preview (cashier / manager / owner hold bills.finalize) says exactly what applies.
  const [preview, setPreview] = useState<BillPreview | null>(null);
  const previewId = server?.id ?? null;
  const canPreview = !!perms?.includes("bills.finalize");
  useEffect(() => {
    if (!previewId || !canPreview || !online) return;
    let live = true;
    api.billPreview(previewId).then((p) => { if (live) setPreview(p); }).catch(() => {});
    return () => { live = false; };
  }, [previewId, canPreview, online, server?.subtotal]);
  const neverSent = local.some((o) => o.op.type === "create_order" && o.attempts === 0 && o.status !== "synced");
  // Before the KOT the waiter-level cancel-unsent applies; with a KOT only a cashier/manager (orders.cancel). Unknown permissions: show it, the server decides.
  const canCancelAfterKot = !perms || perms.includes("orders.cancel");
  const canCancelUnsent = neverSent || !perms || perms.includes("orders.cancel_unsent") || perms.includes("orders.cancel");
  const cancelled = server?.status === "cancelled" || cancel.state === "done";

  // Items that did not reach the server, or an order the server has not confirmed: the bill cannot be asked for yet (it would be for an order the counter does not have)
  const failedStep = local.some((o) => o.status === "failed" && (o.op.type === "create_order" || o.op.type === "add_lines" || o.op.type === "send_kot"));
  const billBlock: "failed" | "unconfirmed" | null = failedStep || state?.order === "failed" || state?.kot === "failed" ? "failed" : state && state.order !== "confirmed" ? "unconfirmed" : null;

  async function requestBill() {
    await submit([{ op: { type: "bill_request", order_client_uuid: ref, requested_at: new Date().toISOString() }, order_ref: ref, label: "Bill request", dedupe_key: `bill:${ref}` }]);
  }
  async function doCancel() {
    setAskCancel(false);
    const r = await engine.cancelUnsent(ref, server?.id ?? null, kotSent);
    if (r === "busy") { setNote(t("cancel.busy")); return; }
    if (r === "dropped") { router.replace("/orders"); return; }
    void retryNow(ref);
  }
  async function removeLine(opId: string, index: number) {
    const r = await engine.removeLine(opId, index);
    if (r === "dropped" && !server) { router.replace("/orders"); return; } // the whole order was only that line
    setNote(r === "uncertain" ? t("order.lineUncertain") : r === "busy" ? t("cancel.busy") : t("order.lineRemoved"));
  }
  async function removeServerLine(lineId: string) {
    if (!server) return;
    try { setServer(await api.removeOrderLine(server.id, lineId)); setNote(t("order.lineRemoved")); }
    catch (e) { setNote(e instanceof ApiError && (e.status === 404 || e.status === 405 || e.status === 501) ? t("move.unsupported") : t("move.failed", { error: e instanceof Error ? e.message : "" })); }
  }
  async function moveOrMerge(kind: "move" | "merge", target: string, label: string) {
    if (!server) return;
    try {
      if (kind === "move") await api.transferOrder(server.id, target); else await api.mergeOrders(server.id, target);
      setNote(kind === "move" ? t("move.done", { name: label }) : t("merge.done"));
      setPanel(null);
      if (kind === "merge") router.replace("/orders"); else setServer(await api.order(server.id));
    } catch (e) {
      const s = e instanceof ApiError ? e.status : -1;
      setNote(s === 404 || s === 405 || s === 501 ? t("move.unsupported") : s === 0 ? t("move.offline") : t("move.failed", { error: e instanceof Error ? e.message : "" }));
    }
  }
  const freeTables = (snap?.tables ?? []).filter((x) => x.is_active && x.id !== tableId && !tableStatus[x.id]);
  const mergeTargets = active.filter((o) => o.id !== server?.id && o.status !== "billed" && o.status !== "cancelled");

  return (
    <AppShell title={tableLabel ? t("order.titleTable", { name: tableLabel }) : server || created ? entryLabel({ ref, ops: local, server: server ?? undefined }, snap?.tables ?? []) : t("order.title")}>
      {state && (
        <div className="row" style={{ flexWrap: "wrap", marginBottom: 10 }}>
          <StatusPill state={state.order} label="order" />
          {state.kot !== "none" && <StatusPill state={state.kot} label="kot" />}
        </div>
      )}
      <LiveStamp />
      {(token || orderNote) && <div className="card">{token ? <strong>{t("order.token", { n: token })}</strong> : null}{orderNote && <div>{t("order.note", { text: orderNote })}</div>}</div>}
      {state?.order !== "confirmed" && state && state.order !== "failed" && <p className="banner">{t("order.notConfirmed")}</p>}
      {state?.order === "failed" && state.errorCode === TABLE_HAS_OPEN_ORDER && !!(state.errorDetails?.existing_order as { bill_id?: string } | undefined)?.bill_id && (
        <UnpaidBillCard total={((state.errorDetails?.existing_order as { total?: string }).total) ?? null} orderId={typeof state.errorDetails?.existing_order_id === "string" ? state.errorDetails.existing_order_id : null}
          onStartNew={() => void retryNow(ref, false, true)}>
          <button className="btn danger" onClick={() => { void engine.discard(ref); router.replace("/orders"); }}>{t("order.discard")}</button>
        </UnpaidBillCard>
      )}
      {state?.order === "failed" && !(state.errorCode === TABLE_HAS_OPEN_ORDER && (state.errorDetails?.existing_order as { bill_id?: string } | undefined)?.bill_id) && (
        <div className="banner err" role="alert">
          {state.error ?? t("order.rejected")}
          {conflicts.map((c, i) => <div key={i} className="small">{t("order.priceChanged", { item: c.item, expected: c.expected, current: c.current })}</div>)}
          <div className="row" style={{ marginTop: 8 }}>
            {state.errorCode !== NOT_AVAILABLE_CODE && <button className="btn" onClick={() => void retryNow(ref, conflicts.length > 0)}>{conflicts.length ? t("order.acceptPrices") : t("order.retry")}</button>}
            <button className="btn danger" onClick={() => { void engine.discard(ref); router.replace("/orders"); }}>{t("order.discard")}</button>
          </div>
        </div>
      )}
      <h2>{t("order.items")}</h2>
      {(server?.lines ?? []).map((l) => (
        <div className="card row" key={l.id}><div className="grow"><strong>{lineName(l.item_id, l.item_name, l.variant_id, l.variant_name)}</strong>{!!l.modifiers?.length && <div className="line-mods">{modifiersText(l.modifiers)}</div>}{l.note && <div className="small muted">{l.note}</div>}</div><span>x{l.quantity}</span><span>{formatMoney(mulDecimal(l.unit_price, l.quantity))}</span>
          {!kotSent && online && server && server.lines.length > 1 && !billed && <button className="btn danger" aria-label={t("order.removeLine", { name: lineName(l.item_id, l.item_name, l.variant_id, l.variant_name) })} onClick={() => void removeServerLine(l.id)}>{t("voice.remove")}</button>}
        </div>
      ))}
      {(() => { const total = entryTotal({ ref, ops: local, server: server ?? undefined }); return total ? <div className="totals"><span>{t("cart.subtotal")}</span><strong className="money">{formatMoney(total)}</strong></div> : null; })()}
      {preview?.offers?.map((o) => <div key={o.offer_id} className="offer-line"><span>{o.label}</span><span className="money">-{formatMoney(o.amount)}</span></div>)}
      {!!preview?.offers?.length && <div className="totals"><span>Bill total (with GST)</span><strong className="money">{formatMoney(preview.total)}</strong></div>}
      {unsent.length > 0 && <h2>{t("order.unsent")}</h2>}
      {unsent.map((l) => (
        <div className="card row" key={`${l.opId}:${l.index}`}>
          <div className="grow"><strong>{lineName(l.item_id, itemName(l.item_id), l.variant_id)}</strong>{l.note && <div className="small muted">{l.note}</div>}</div><span>x{l.quantity}</span>
          {l.editable && <button className="btn danger" aria-label={t("order.removeLine", { name: lineName(l.item_id, itemName(l.item_id), l.variant_id) })} onClick={() => void removeLine(l.opId, l.index)}>{t("voice.remove")}</button>}
        </div>
      ))}
      {kots.length > 0 && <><h2>{t("order.kitchen")}</h2>{kots.map((k) => <div className="card row between" key={k.id}><span>KOT #{k.number}</span><span className="pill" data-testid="kot-state">{kotOnly ? t("order.sentToKitchen") : k.status.charAt(0).toUpperCase() + k.status.slice(1)}</span></div>)}</>}
      {note && <div className="banner" role="status">{note}</div>}

      {bill.state === "queued" && <div className="banner" role="status">{t("bill.queued")}</div>}
      {bill.state === "sending" && <div className="banner" role="status">{t("bill.sending")}</div>}
      {bill.state === "done" && <div className="banner" role="status">{t("bill.done")}</div>}
      {bill.state === "failed" && (
        <div className="banner err" role="alert">{t("bill.failed", { error: bill.error ?? "" })}
          <div style={{ marginTop: 8 }}><button className="btn" onClick={() => void retryNow(ref)}>{t("bill.retry")}</button></div>
        </div>
      )}
      {cancel.state === "queued" && <div className="banner" role="status">{t("cancel.queued")}</div>}
      {cancel.state === "sending" && <div className="banner" role="status">{t("cancel.sending")}</div>}
      {cancel.state === "done" && <div className="banner" role="status">{t("cancel.done")}</div>}
      {cancel.state === "failed" && <div className="banner err" role="alert">{t("cancel.failed", { error: cancel.error ?? "" })}</div>}

      {!billed && !cancelled && (server || local.length > 0) && (
        <>
        <div className="row" style={{ marginTop: 10, flexWrap: "wrap" }}>
          {server && <button className="btn grow" onClick={() => { if (!draftActions.addTo(server.client_uuid, server.table_id)) { setNote("6 bills are open on this phone. Send or close one first (Cart)."); return; } router.push("/menu"); }}>{t("order.addItems")}</button>}
          <button className="btn primary grow" onClick={() => void requestBill()} disabled={!!billBlock || (bill.state !== "none" && bill.state !== "failed")} aria-describedby={billBlock ? "bill-block" : undefined}>{bill.state === "none" || bill.state === "failed" ? t("bill.request") : t("bill.requested")}</button>
        </div>
        {billBlock && (
          <div className="banner" id="bill-block" role="status" data-testid="bill-blocked">
            {billBlock === "failed" ? t("order.sendFailedFirst") : t("order.waitConfirm")}
            {billBlock === "failed" && <div style={{ marginTop: 8 }}><button className="btn" onClick={() => void retryNow(ref, conflicts.length > 0)}>{t("order.retryItems")}</button></div>}
          </div>
        )}
        </>
      )}
      {!billed && !cancelled && (server || local.length > 0) && cancel.state === "none" && (
        <div style={{ marginTop: 10 }}>
          {!askCancel && (kotSent ? canCancelAfterKot : canCancelUnsent) && <button className="btn danger block" onClick={() => setAskCancel(true)}>{t("cancel.button")}</button>}
          {!kotSent || canCancelAfterKot ? null : <p className="small muted">{t("cancel.needManager")}</p>}
          {askCancel && (
            <div className="card" role="alertdialog" aria-label={t("cancel.ask")}>
              <p><strong>{t("cancel.ask")}</strong></p>
              <div className="row"><button className="btn danger grow" onClick={() => void doCancel()}>{t("cancel.yes")}</button><button className="btn grow" onClick={() => setAskCancel(false)}>{t("cancel.no")}</button></div>
            </div>
          )}
        </div>
      )}
      {server && !billed && !cancelled && (
        <div style={{ marginTop: 10 }}>
          <div className="row" style={{ flexWrap: "wrap" }}>
            {server.table_id && <button className="btn grow" disabled={!online} onClick={() => setPanel(panel === "move" ? null : "move")}>{t("move.button")}</button>}
            <button className="btn grow" disabled={!online} onClick={() => setPanel(panel === "merge" ? null : "merge")}>{t("merge.button")}</button>
          </div>
          {!online && <p className="small muted">{t("move.offline")}</p>}
          {panel === "move" && (
            <div className="card" role="group" aria-label={t("move.pick")}><strong>{t("move.pick")}</strong>
              {!freeTables.length && <p className="muted">{t("move.none")}</p>}
              <div className="grid">{freeTables.map((x) => <button key={x.id} className="tile" onClick={() => void moveOrMerge("move", x.id, x.label)}>{x.label}</button>)}</div>
            </div>
          )}
          {panel === "merge" && (
            <div className="card" role="group" aria-label={t("merge.pick")}><strong>{t("merge.pick")}</strong>
              {!mergeTargets.length && <p className="muted">{t("merge.none")}</p>}
              {mergeTargets.map((o) => <button key={o.id} className="btn block" style={{ marginTop: 8 }} onClick={() => void moveOrMerge("merge", o.id, "")}>{o.table_id ? (snap?.tables.find((x) => x.id === o.table_id)?.label ?? "?") : o.order_type} · {formatMoney(o.subtotal)}</button>)}
            </div>
          )}
        </div>
      )}
      <p><Link href="/orders">{t("order.back")}</Link></p>
    </AppShell>
  );
}
