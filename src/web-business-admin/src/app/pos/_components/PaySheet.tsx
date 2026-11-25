"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Banknote, CreditCard, QrCode, X } from "lucide-react";
import { Button, Keypad, Sheet } from "@chilli/ui";
import { useLocale, useMsg, type Catalog } from "@/lib/i18n";
import { formatCurrency } from "@/lib/money";
import { extras } from "@/lib/extras";
import { qrMatrix, qrPath } from "@/lib/qr";
import { uuid } from "@/lib/uuid";
import { cn } from "@/lib/cn";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { UPI_NATIVE, planPayment, sub, validEntry, type PayLine, type TenderKind } from "./pay-plan";

const KINDS: { kind: TenderKind; icon: typeof Banknote }[] = [
  { kind: "cash", icon: Banknote },
  { kind: "card", icon: CreditCard },
  { kind: "upi", icon: QrCode },
];

const MSG = {
  cash: { en: "Cash", hi: "नकद", hinglish: "Cash" },
  card: { en: "Card", hi: "कार्ड", hinglish: "Card" },
  upi: { en: "UPI", hi: "UPI", hinglish: "UPI" },
  title: { en: "Take payment", hi: "भुगतान लें", hinglish: "Payment lein" },
  balance: { en: "Balance {amt}", hi: "बाकी {amt}", hinglish: "Baaki {amt}" },
  split: { en: "Add {amt} as {kind} and split the rest", hi: "{amt} {kind} में जोड़ें और बाकी बाँटें", hinglish: "{amt} {kind} mein jodein aur baaki baantein" },
  confirm: { en: "Confirm payment", hi: "भुगतान पक्का करें", hinglish: "Payment pakka karein" },
  added: { en: "Payments added", hi: "जोड़े गए भुगतान", hinglish: "Jode gaye payments" },
  remove: { en: "Remove {kind} {amt}", hi: "हटाएं {kind} {amt}", hinglish: "Hatayein {kind} {amt}" },
  method: { en: "Payment method", hi: "भुगतान का तरीका", hinglish: "Payment ka tareeka" },
  upiNote: { en: "UPI is recorded as \"Other\" for now. ", hi: "UPI अभी \"अन्य\" के रूप में दर्ज होता है। ", hinglish: "UPI abhi \"Other\" ke roop mein darj hota hai. " },
  upiCheck: { en: "Check the customer's payment screen before you confirm.", hi: "पक्का करने से पहले ग्राहक की पेमेंट स्क्रीन देख लें।", hinglish: "Pakka karne se pehle customer ki payment screen dekh lein." },
  cashIn: { en: "Cash received", hi: "नकद मिला", hinglish: "Cash mila" },
  amountOf: { en: "{kind} amount", hi: "{kind} राशि", hinglish: "{kind} amount" },
  stillToPay: { en: "Still to pay", hi: "अभी देना बाकी", hinglish: "Abhi dena baaki" },
  changeDue: { en: "Change due", hi: "वापस देना है", hinglish: "Wapas dena hai" },
  tooMuch: { en: "That is more than the balance. {kind} cannot give change.", hi: "यह बाकी राशि से ज़्यादा है। {kind} में छुट्टा नहीं मिलता।", hinglish: "Yeh baaki se zyada hai. {kind} mein change nahi milta." },
  upiLoading: { en: "Loading UPI QR…", hi: "UPI QR लोड हो रहा है…", hinglish: "UPI QR load ho raha hai…" },
  upiNone: { en: "No UPI id saved. Add it in Manage > Restaurant > UPI payments to show a QR.", hi: "UPI आईडी सेव नहीं है। QR दिखाने के लिए Manage > Restaurant > UPI payments में जोड़ें।", hinglish: "UPI id save nahi hai. QR dikhane ke liye Manage > Restaurant > UPI payments mein jodein." },
  upiFail: { en: "Could not load the UPI id.", hi: "UPI आईडी लोड नहीं हो सकी।", hinglish: "UPI id load nahi ho saki." },
  upiRetry: { en: "Try again", hi: "फिर कोशिश करें", hinglish: "Phir koshish karein" },
  upiAmount: { en: "Enter the amount to show the QR.", hi: "QR दिखाने के लिए राशि डालें।", hinglish: "QR dikhane ke liye amount dalein." },
  exact: { en: "Exact", hi: "ठीक राशि", hinglish: "Exact" },
  quick: { en: "Quick cash amounts", hi: "जल्दी नकद राशि", hinglish: "Quick cash amounts" },
  keypad: { en: "Amount keypad", hi: "राशि कीपैड", hinglish: "Amount keypad" },
} satisfies Catalog;

/** The DS keypad shows whole text amounts; this turns its paise into the restaurant's currency string. */
const paiseText = (p: bigint) => `${p / 100n}.${String(p % 100n).padStart(2, "0")}`;

/**
 * Payment sheet for a finalized bill: pick how the customer pays, type what was handed over (cash shows the change due),
 * split between payers by adding lines that sum to the balance, then one explicit "Confirm payment". Nothing is booked
 * before the confirm. UPI is recorded as the API's "other" method (no UPI method or gateway exists yet).
 * `onPay` should throw to keep the sheet open (the caller shows the message).
 */
export function PaySheet({ open, onClose, balance, currency, initialKind, busy, onPay, payeeName }: {
  payeeName?: string; open: boolean; onClose: () => void; balance: string; currency: string; initialKind: TenderKind; busy: boolean;
  onPay: (lines: PayLine[]) => Promise<void>;
}) {
  const t = useMsg(MSG);
  const { locale } = useLocale();
  const KIND_LABEL: Record<TenderKind, string> = { cash: t("cash"), card: t("card"), upi: t("upi") };
  const [kind, setKind] = useState<TenderKind>(initialKind);
  const [lines, setLines] = useState<PayLine[]>([]);
  const remainingNow = planPayment(balance, lines, kind, "").remaining;
  const [entry, setEntry] = useState<string | null>(null); // null = untouched: shows the exact remaining amount
  const keys = useRef<Record<TenderKind, string>>({ cash: uuid(), card: uuid(), upi: uuid() }); // stable per sheet so a retry never double-books
  const shown = entry ?? remainingNow;
  const plan = planPayment(balance, lines, kind, shown);
  const money = (v: string) => formatCurrency(v, currency);
  const [vpa, setVpa] = useState<string | null | undefined>(undefined); // undefined = loading, null = none saved
  const [vpaFailed, setVpaFailed] = useState(false); // the lookup itself failed (offline / server): offer a retry, never claim "none saved"
  const [vpaTry, setVpaTry] = useState(0);
  useEffect(() => {
    if (kind !== "upi" || vpa !== undefined) return;
    let live = true;
    extras.upi().then((r) => { if (live) { setVpa(r.upi_vpa ?? null); setVpaFailed(false); } }).catch(() => { if (live) setVpaFailed(true); });
    return () => { live = false; };
  }, [kind, vpa, vpaTry]);
  const upiUri = kind === "upi" && vpa && cmpPositive(plan.applied)
    ? `upi://pay?pa=${encodeURIComponent(vpa).replace(/%40/g, "@")}&pn=${encodeURIComponent(payeeName || "Restaurant")}&am=${plan.applied}&cu=${encodeURIComponent(currency)}` : null;
  const wide = useMediaQuery("(min-width: 768px)"); // a 420px drawer beside the bill on tablets / desktops, a bottom sheet on phones

  // Untouched = "exact amount due" (shown in the lines above); the keypad starts empty so a typed digit never lands on
  // a two-decimal figure it cannot extend. "Exact" and the quick notes set the entry explicitly.
  const onKeypad = (next: string) => { if (validEntry(next)) setEntry(next === "" ? null : next); };
  const trim = (v: string) => v.replace(/\.00$/, ""); // "129.00" -> "129" so the keypad can show and extend it
  const quick = kind === "cash" ? quickNotes(plan.remaining) : [];
  const lineOf = (): PayLine => ({ kind, amount: plan.applied, tendered: kind === "cash" ? shown : undefined, key: keys.current[kind] });
  const split = () => { setLines((l) => [...l, { ...lineOf(), key: uuid() }]); setEntry(null); };
  async function confirm() {
    const all = plan.remaining === "0.00" ? lines : [...lines, lineOf()];
    await onPay(all);
  }

  return (
    <Sheet side={wide ? "right" : "bottom"} open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }} title={t("title")} description={t("balance", { amt: money(balance) })} locale={locale}
      footer={<div className="flex w-full flex-col gap-2">
        {plan.canSplit && <Button size="lg" className="w-full" disabled={busy} onClick={split}>{t("split", { amt: money(plan.applied), kind: KIND_LABEL[kind] })}</Button>}
        <Button variant="primary" size="pay" className="w-full" loading={busy} disabled={!plan.canConfirm} onClick={() => void confirm()}>
          {t("confirm")}{plan.canConfirm ? ` ${money(balance)}` : ""}
        </Button>
      </div>}>
      <div className="space-y-4 pb-3">
        {lines.length > 0 && (
          <ul aria-label={t("added")} className="space-y-1.5">
            {lines.map((l, i) => (
              <li key={l.key} className="flex items-center justify-between gap-2 rounded-xl bg-surface-2 px-3 py-2 text-sm">
                <span className="font-medium text-fg">{KIND_LABEL[l.kind]}</span>
                <span className="tnum font-semibold">{money(l.amount)}</span>
                <button type="button" aria-label={t("remove", { kind: KIND_LABEL[l.kind], amt: money(l.amount) })} disabled={busy} onClick={() => { setLines((x) => x.filter((_, j) => j !== i)); setEntry(null); }}
                  className="grid size-11 place-items-center rounded-lg text-fg-subtle hover:bg-surface-3"><X aria-hidden className="size-4" /></button>
              </li>
            ))}
          </ul>
        )}

        <div role="radiogroup" aria-label={t("method")} className="grid grid-cols-3 gap-2">
          {KINDS.map((k) => (
            <button key={k.kind} type="button" role="radio" aria-checked={kind === k.kind} disabled={busy} onClick={() => { setKind(k.kind); setEntry(null); }}
              className={cn("flex h-14 flex-col items-center justify-center gap-0.5 rounded-xl border text-sm font-semibold", kind === k.kind ? "border-primary bg-primary-soft text-primary-soft-fg" : "border-border bg-surface text-fg-muted hover:bg-surface-2")}>
              <k.icon aria-hidden className="size-5" />{KIND_LABEL[k.kind]}
            </button>
          ))}
        </div>
        {kind === "upi" && <p className="text-xs text-fg-muted">{UPI_NATIVE ? "" : t("upiNote")}{t("upiCheck")}</p>}

        {kind === "upi" && (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-border bg-surface p-3" data-testid="upi-qr">
            {upiUri ? <UpiQr uri={upiUri} /> : vpaFailed
              ? <p className="text-sm text-fg-muted">{t("upiFail")} <button type="button" className="font-semibold text-primary underline" onClick={() => { setVpaFailed(false); setVpaTry((n) => n + 1); }}>{t("upiRetry")}</button></p>
              : <p className="text-sm text-fg-muted">{vpa === undefined ? t("upiLoading") : vpa === null ? t("upiNone") : t("upiAmount")}</p>}
            {upiUri && <p className="tnum text-sm font-semibold">{money(plan.applied)} · {vpa}</p>}
          </div>
        )}

        <div>
          <p className="text-sm font-medium text-fg-muted">{kind === "cash" ? t("cashIn") : t("amountOf", { kind: KIND_LABEL[kind] })}</p>
          <dl className="mt-2 space-y-1 text-sm">
            {lines.length > 0 && <div className="flex justify-between"><dt className="text-fg-muted">{t("stillToPay")}</dt><dd className="tnum font-semibold">{money(plan.remaining)}</dd></div>}
            {kind === "cash" && cmpPositive(plan.change) && <div className="flex justify-between"><dt className="font-semibold text-fg">{t("changeDue")}</dt><dd data-testid="change-due" className="tnum font-display text-xl font-extrabold text-success-fg">{money(plan.change)}</dd></div>}
            {kind !== "cash" && cmpPositive(sub(shown || "0", plan.remaining)) && <p role="alert" className="font-medium text-danger-fg">{t("tooMuch", { kind: KIND_LABEL[kind] })}</p>}
          </dl>
        </div>

        {quick.length > 0 && (
          <div className="flex flex-wrap gap-2" role="group" aria-label={t("quick")}>
            <Button onClick={() => setEntry(trim(plan.remaining))}>{t("exact")}</Button>
            {quick.map((q) => <Button key={q} onClick={() => setEntry(trim(q))}>{formatCurrency(q, currency, 0)}</Button>)}
          </div>
        )}

        <Keypad value={entry ?? ""} onChange={onKeypad} allowDecimal label={t("keypad")} locale={locale}
          format={(p, dec) => formatCurrency(paiseText(p), currency, dec || p % 100n !== 0n ? 2 : 0)} />
      </div>
    </Sheet>
  );
}

const cmpPositive = (v: string) => Number(v) > 0; // display-only guard on already-exact strings

/** Common notes above the balance: the next 10 / 50 / 100 / 500 multiples (deduplicated, at most 3). */
function quickNotes(remaining: string): string[] {
  const r = Math.ceil(Number(remaining));
  const out = new Set<number>();
  for (const step of [10, 50, 100, 500]) { const v = Math.ceil(r / step) * step; if (v > Number(remaining)) out.add(v); }
  return [...out].slice(0, 3).map((v) => `${v}.00`);
}

function UpiQr({ uri }: { uri: string }) {
  const m = useMemo(() => { try { return qrMatrix(uri); } catch { return null; } }, [uri]);
  if (!m) return null;
  const n = m.length + 8;
  return (
    <svg role="img" aria-label="UPI QR code" viewBox={`0 0 ${n} ${n}`} width={200} height={200} shapeRendering="crispEdges" className="rounded-lg">
      <rect width={n} height={n} fill="#fff" />
      <path d={qrPath(m)} fill="#000" />
    </svg>
  );
}
