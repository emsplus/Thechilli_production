"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, ExternalLink, Wallet } from "lucide-react";
import { Button, Dialog, Input, Notice } from "@chilli/ui";
import { ApiError } from "@/lib/api";
import { billingApi, canTopUpOnline, chilli, parseRechargeRupees, RECHARGE_DEFAULT, RECHARGE_QUICK, rechargeProblem, rupeesWhole, TOPUP_SOON, type BillingBlock } from "@/lib/billing";

/**
 * Recharge (docs/CHILLI_WALLET.md): the owner picks an amount (whole rupees, at least ₹2,000, 1 rupee = 1 Chilli), we create a
 * Razorpay payment link on Chilli's account and open it in a new tab. Nothing is credited by this screen: the signed Razorpay
 * webhook credits platform-core, and `RechargeWatcher` polls GET /billing/topups/{id} until it says paid, then shows
 * "Added 2,000 Chilli". The pending recharge lives in localStorage so it survives the redirect back from Razorpay.
 */
const KEY = "chilli.recharge";
const EVENT = "chilli:recharge";
const POLL_MS = 3000;
const GIVE_UP_MS = 15 * 60_000;
const SLOW_MS = 90_000;

interface Pending { id: string; amount_paise: number; at: number }
const read = (): Pending | null => { try { const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Pending | null; return v && v.id && Date.now() - v.at < GIVE_UP_MS ? v : null; } catch { return null; } };
const write = (p: Pending | null) => { try { if (p) localStorage.setItem(KEY, JSON.stringify(p)); else localStorage.removeItem(KEY); } catch { /* storage blocked: the dialog still opens the payment page */ } window.dispatchEvent(new Event(EVENT)); };
/** Razorpay sends the owner back with ?razorpay_payment_link_reference_id=<our recharge id> (the payment link's reference_id). */
const returnedId = (): string | null => { try { const id = new URLSearchParams(window.location.search).get("razorpay_payment_link_reference_id"); return id && /^[0-9a-f-]{36}$/i.test(id) ? id : null; } catch { return null; } };
const cleanUrl = () => { try { const u = new URL(window.location.href); for (const k of [...u.searchParams.keys()]) if (k.startsWith("razorpay_")) u.searchParams.delete(k); window.history.replaceState(null, "", u.toString()); } catch { /* ignore */ } };

type Watch = { kind: "idle" } | { kind: "waiting"; id: string; amount: number; slow: boolean } | { kind: "paid"; chilli: string; balance?: string } | { kind: "expired" };

/** Watches the pending recharge (if any) until it is credited. `onPaid` runs once when the Chilli have been added. */
export function RechargeWatcher({ onPaid }: { onPaid?: () => void }) {
  const [w, setW] = useState<Watch>({ kind: "idle" });
  const paidCb = useRef(onPaid);
  useEffect(() => { paidCb.current = onPaid; });

  useEffect(() => {
    let off = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const start = () => {
      if (timer) clearTimeout(timer);
      const back = returnedId();
      const p = back ? { id: back, amount_paise: read()?.id === back ? read()!.amount_paise : 0, at: read()?.id === back ? read()!.at : Date.now() } : read();
      if (!p) { setW((x) => (x.kind === "waiting" ? { kind: "idle" } : x)); return; }
      if (back) write(p);
      const began = Date.now();
      const tick = async () => {
        if (off) return;
        try {
          const s = await billingApi.topupStatus(p.id);
          if (off) return;
          if (s.intent.status === "paid") {
            write(null); cleanUrl();
            setW({ kind: "paid", chilli: chilli(s.intent.amount_paise), balance: s.billing ? chilli(s.billing.balance_paise) : undefined });
            paidCb.current?.();
            return;
          }
          if (s.intent.status === "expired" || s.intent.status === "failed") { write(null); cleanUrl(); setW({ kind: "expired" }); return; }
        } catch (e) {
          if (e instanceof ApiError && e.status === 404) { write(null); setW({ kind: "idle" }); return; }
          /* offline or a hiccup: keep waiting */
        }
        if (Date.now() - p.at > GIVE_UP_MS) { write(null); setW({ kind: "idle" }); return; }
        setW({ kind: "waiting", id: p.id, amount: p.amount_paise, slow: Boolean(back) && Date.now() - began > SLOW_MS });
        timer = setTimeout(() => void tick(), POLL_MS);
      };
      setW({ kind: "waiting", id: p.id, amount: p.amount_paise, slow: false });
      void tick();
    };
    void Promise.resolve().then(start);
    window.addEventListener(EVENT, start);
    return () => { off = true; if (timer) clearTimeout(timer); window.removeEventListener(EVENT, start); };
  }, []);

  if (w.kind === "idle") return null;
  return (
    <div data-testid="recharge-status" data-kind={w.kind} role="status" aria-live="polite">
      {w.kind === "waiting" && (
        <Notice tone="info" title="Waiting for your payment">
          {w.slow ? "We have not received the payment yet. This can take a minute. Your Chilli are added by themselves when it arrives; you do not need to pay again."
            : "Finish paying in the Razorpay tab. Your Chilli appear here as soon as the payment is received."}
        </Notice>
      )}
      {w.kind === "paid" && (
        <Notice tone="success" title={`Added ${w.chilli}`}>
          <span className="inline-flex items-center gap-1.5"><CheckCircle2 aria-hidden className="size-4" />{w.balance ? `Your balance is now ${w.balance}.` : "Your balance is updated."}</span>
        </Notice>
      )}
      {w.kind === "expired" && <Notice tone="warning" title="That payment page expired">No money was taken. Choose Recharge to try again.</Notice>}
    </div>
  );
}

/** "Recharge" button with the amount dialog (default ₹2,000, quick buttons 2,000 / 5,000 / 10,000). */
export function RechargeButton({ b, mayTopUp, size = "md" }: { b: BillingBlock; mayTopUp: boolean; size?: "sm" | "md" }) {
  const online = canTopUpOnline(b, mayTopUp);
  const [soon, setSoon] = useState(false);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(String(RECHARGE_DEFAULT));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const rupees = parseRechargeRupees(amount);

  const close = useCallback((v: boolean) => { setOpen(v); if (!v) { setLink(null); setErr(null); } }, []);

  async function start() {
    const problem = rechargeProblem(amount, b);
    if (problem || rupees === null) { setErr(problem ?? "Enter an amount in rupees"); return; }
    setBusy(true); setErr(null);
    try {
      const r = await billingApi.topupIntent(rupees * 100);
      write({ id: r.intent.id, amount_paise: r.intent.amount_paise, at: Date.now() });
      const win = window.open(r.checkout.url, "_blank"); // not "noopener": that always returns null, which cannot be told from a blocked pop-up
      if (win) { try { win.opener = null; } catch { /* cross-origin already */ } close(false); }
      else setLink(r.checkout.url); // a pop-up blocker: offer the link itself
    } catch (e) {
      if (e instanceof ApiError && e.code === "topup_unavailable") { setOpen(false); setSoon(true); }
      else setErr(e instanceof ApiError && e.status !== 0 ? e.message : "Cannot reach the server. Try again when you are online.");
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-2">
      <Button size={size} variant={online ? "primary" : "secondary"} iconStart={<Wallet />} data-testid="recharge-open" aria-expanded={online ? undefined : soon}
        onClick={() => (online ? setOpen(true) : setSoon((v) => !v))}>Recharge</Button>
      {soon && <p role="status" data-testid="topup-soon" className="text-sm font-medium text-fg-muted">{TOPUP_SOON}</p>}
      {online && (
        <Dialog open={open} onOpenChange={close} title="Recharge Chilli" description={`1 rupee = 1 Chilli. Each bill uses ${chilli(b.per_bill_paise)}.`}
          footer={link ? <Button variant="secondary" onClick={() => close(false)}>Close</Button>
            : <><Button variant="secondary" onClick={() => close(false)}>Cancel</Button>
              <Button variant="primary" loading={busy} data-testid="recharge-pay" disabled={rupees === null} onClick={() => void start()}>{rupees ? `Pay ${rupeesWhole(rupees)}` : "Pay"}</Button></>}>
          {link ? (
            <div className="space-y-2" data-testid="recharge-link">
              <p className="text-sm text-fg-muted">Your browser blocked the new tab. Open the payment page here:</p>
              <a className="inline-flex items-center gap-1.5 font-semibold text-primary underline" href={link} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden className="size-4" />Open payment page</a>
            </div>
          ) : (
            <div className="space-y-3">
              <Input label="Amount (₹)" inputMode="numeric" value={amount} error={err ?? undefined} data-testid="recharge-amount"
                hint={`At least ${rupeesWhole(Math.round((b.min_topup_paise ?? 200_000) / 100))}`} onChange={(e) => { setAmount(e.target.value); setErr(null); }} />
              <div className="flex flex-wrap gap-2" role="group" aria-label="Quick amounts">
                {RECHARGE_QUICK.map((n) => (
                  <Button key={n} size="sm" variant={rupees === n ? "primary" : "secondary"} aria-pressed={rupees === n} onClick={() => { setAmount(String(n)); setErr(null); }}>{rupeesWhole(n)}</Button>
                ))}
              </div>
              <p className="text-sm font-medium text-fg" data-testid="recharge-get">{rupees ? `You get ${chilli(rupees * 100)}` : "Enter a whole number of rupees"}</p>
              <p className="text-xs text-fg-subtle">You pay on the Razorpay page. The Chilli are added to your account as soon as the payment is received.</p>
            </div>
          )}
        </Dialog>
      )}
    </div>
  );
}
