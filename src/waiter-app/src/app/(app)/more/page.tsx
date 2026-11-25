"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { api, auth } from "@/lib/api";
import { useMenu } from "@/lib/menu";
import { defaultSessionGateway as gw, shiftSyncState } from "@/lib/session";
import { retryNow, syncNow, useOnline, useQueue } from "@/lib/sync";
import type { Me } from "@/lib/types";
import Link from "next/link";
import { useT, type Key } from "@/lib/i18n";
import { NOT_AVAILABLE_CODE } from "@/lib/capabilities";
import { useClock } from "@/lib/attendance";
import { isShiftRef } from "@/lib/orderEntries";
import { opLabel } from "@/lib/opLabel";
import { counterState } from "@/lib/counter/state";
import { endPinSession } from "@/lib/counter/actions";

const SHIFT_KEY: Record<string, Key> = { queued: "shift.queued", sending: "shift.sending", recorded: "shift.recorded", local_only: "shift.localOnly", failed: "shift.failed" };
export default function More() {
  const router = useRouter();
  const t = useT();
  const ops = useQueue();
  const { snap, refresh } = useMenu();
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => { api.me().then(setMe).catch(() => {}); }, []);
  const unsynced = ops.filter((o) => o.status !== "synced");
  const shift = gw.currentShift();
  const sync = shift ? shiftSyncState(ops, shift.id) : null;
  const clock = useClock();
  const online = useOnline();
  const since = clock.state.since ? new Date(clock.state.since).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true }).toLowerCase() : null;

  const counter = counterState.active;
  async function signOut() {
    if (counter) { await endPinSession("switch_user"); router.replace("/counter"); return; } // shared tablet: unsent orders wait for this person's next PIN sign-in
    if (unsynced.length && !confirm(t("more.signOutConfirm", { n: unsynced.length }))) return;
    await api.logout();
    auth.clear();
    router.replace("/login");
  }
  async function closeShift() {
    const waiting = unsynced.filter((o) => !isShiftRef(o.order_ref)).length;
    if (waiting && !confirm(t("shift.endConfirm", { name: shift?.outlet_name ?? "", n: waiting }))) return;
    await gw.closeShift();
    router.replace("/outlet");
  }

  return (
    <AppShell title={t("more.title")}>
      <div className="card"><strong>{me?.full_name ?? t("more.signedIn")}</strong><div className="muted small">{me?.role}</div></div>
      {shift && (
        <div className="card">
          <strong>{t("more.outlet", { name: shift.outlet_name ?? "" })}</strong>
          {sync && <div className="small muted" role="status">{t(SHIFT_KEY[sync])}</div>}
        </div>
      )}
      {clock.supported && (
        <div className="card clock">
          <div className="grow">
            <strong>{clock.state.open ? "Clocked in" : "Not clocked in"}</strong>
            <div className="small muted" role="status">
              {clock.state.open && since ? `Since ${since}` : "Attendance for today"}
              {clock.failed ? ` · ${clock.failed.error ?? "Could not be saved"}` : clock.pending ? (online ? " · Saved on this phone, sending…" : " · Saved on this phone, sends when online") : ""}
            </div>
          </div>
          <button className={`btn${clock.state.open ? "" : " primary"}`} onClick={() => void clock.tap()}>{clock.state.open ? "Clock out" : "Clock in"}</button>
        </div>
      )}
      {!counter && <Link className="btn block" style={{ marginBottom: 10 }} href="/more/security">Security (MPIN, fingerprint)</Link>}
      <Link className="btn block" style={{ marginBottom: 10 }} href="/history">{t("more.history")}</Link>
      {!counter && <Link className="btn block" style={{ marginBottom: 10 }} href="/outlet">{t("more.switchOutlet")}</Link>}
      <button className="btn block" style={{ marginBottom: 10 }} onClick={() => void refresh()}>{t("more.refreshMenu")} {snap ? `(${t("more.saved", { time: new Date(snap.savedAt).toLocaleTimeString() })})` : ""}</button>
      <button className="btn block" style={{ marginBottom: 10 }} onClick={() => void syncNow()}>{t("more.sync")}</button>
      <h2>{t("more.queue")}</h2>
      {!ops.length && <p className="muted">{t("more.nothingQueued")}</p>}
      {[...ops].reverse().slice(0, 30).map((o) => (
        <div className="card row" key={o.op_id}>
          <div className="grow"><strong>{opLabel(o, t)}</strong><div className="small muted">{new Date(o.created_at).toLocaleTimeString()} · {t("q.attempts", { n: o.attempts })}{o.error ? ` · ${o.error}` : ""}</div></div>
          <span className={`pill ${o.status === "synced" ? "synced" : o.status === "failed" ? "failed" : "pending"}`}>{o.status === "synced" ? t("q.synced") : o.status === "failed" ? t("q.failed") : o.status === "syncing" ? t("q.sending") : t("q.pending")}</span>
          {o.status === "failed" && o.error_code !== NOT_AVAILABLE_CODE && <button className="btn" onClick={() => void retryNow(o.order_ref)}>{t("q.retry")}</button>}
        </div>
      ))}
      <h2>{t("more.shift")}</h2>
      <button className="btn block" style={{ marginBottom: 10 }} onClick={() => void closeShift()}>{t("more.closeShift")}</button>
      <button className="btn danger block" onClick={() => void signOut()}>{counter ? "Switch user" : t("more.signOut")}</button>
    </AppShell>
  );
}
