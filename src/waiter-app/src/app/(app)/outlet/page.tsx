"use client";
import { isShiftRef } from "@/lib/orderEntries";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { draftActions, useDraft } from "@/lib/draft";
import { defaultSessionGateway as gw, shiftSyncState, type Outlet } from "@/lib/session";
import { useQueue } from "@/lib/sync";
import { useT, type Key } from "@/lib/i18n";
import { ApiError } from "@/lib/api";
import { homeRouteNow } from "@/lib/capsStore";

const SYNC_KEY: Record<string, Key> = { queued: "shift.queued", sending: "shift.sending", recorded: "shift.recorded", local_only: "shift.localOnly", failed: "shift.failed" };

/** First screen after sign-in and the outlet switcher. Works for waiters (only their granted outlets are listed) and owners alike. */
export default function OutletPage() {
  const router = useRouter();
  const t = useT();
  const draft = useDraft();
  const ops = useQueue();
  const [outlets, setOutlets] = useState<Outlet[] | null>(null);
  const [cached, setCached] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const shift = gw.currentShift();
  useEffect(() => { gw.listOutlets().then((r) => { setOutlets(r.outlets); setCached(r.fromCache); }).catch((e) => { setOutlets([]); setErr(e instanceof Error ? e.message : t("outlet.failed")); }); }, [t]);

  const waitingFor = (id: string) => ops.filter((o) => o.status !== "synced" && o.outlet_id === id && !isShiftRef(o.order_ref)).length;
  async function pick(o: Outlet) {
    if (busy) return;
    setErr(null); setBusy(o.id);
    try {
      if (shift) { await gw.switchOutlet(o.id, o.name); draftActions.setTable(null); } else await gw.openShift(o.id, o.name);
      router.replace(draft.mode === "dine_in" ? homeRouteNow() : "/menu");
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 403 ? t("outlet.forbidden") : e instanceof Error && e.message === "offline-unknown-outlet" ? t("outlet.offlineUnknown") : t("outlet.failed"));
      setBusy(null);
    }
  }
  const sync = shift ? shiftSyncState(ops, shift.id) : null;
  return (
    <AppShell title={t("outlet.title")}>
      {shift && (
        <div className="card">
          <strong>{t("outlet.current", { name: shift.outlet_name ?? "", time: new Date(shift.started_at).toLocaleTimeString() })}</strong>
          {sync && <div className="small muted" role="status">{t(SYNC_KEY[sync])}</div>}
        </div>
      )}
      {!shift && <p className="muted" style={{ marginTop: 0 }}>Start your shift where you are working today. Your orders go to that outlet&apos;s kitchen and cashier.</p>}
      {outlets === null && !err && <div className="dish skel" style={{ minHeight: 56, borderRadius: 999 }} role="status" aria-label={t("outlet.loading")} />}
      {cached && <div className="banner" role="status">{t("outlet.cached")}</div>}
      {err && <div className="banner err" role="alert">{err}</div>}
      {outlets?.length === 0 && !err && <p className="muted">{t("outlet.none")}</p>}
      {outlets?.map((o) => {
        const n = waitingFor(o.id), here = shift?.outlet_id === o.id;
        return (
          <div key={o.id} style={{ marginBottom: 10 }}>
            {!here && <button className="btn primary block" disabled={!!busy} onClick={() => void pick(o)}>{shift ? t("outlet.switch", { name: o.name }) : t("outlet.start", { name: o.name })}</button>}
            {here && <div className="btn block" aria-current="true">{o.name}</div>}
            {n > 0 && <p className="small muted">{t("outlet.waiting", { n, name: o.name })}</p>}
          </div>
        );
      })}
    </AppShell>
  );
}
