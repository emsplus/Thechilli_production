"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { draftActions } from "@/lib/draft";
import { useDialogFocus } from "@/lib/dialogFocus";
import { useT, type Key } from "@/lib/i18n";
import { useMenu } from "@/lib/menu";
import { formatMoney, mulDecimal } from "@/lib/money";
import { makeLine, type CartLine } from "@/lib/cart";
import { canRecord, micPermission, startRecording, type Recording } from "@/lib/recorder";
import { useOnline } from "@/lib/sync";
import { uuid } from "@/lib/uuid";
import { voiceProvider, VoiceError, type VoiceErrorCode, type VoiceLang } from "@/lib/voice";
import { doneMenuOf, splitDone } from "@/lib/voiceDone";
import { blocker, buildReview, heardToShow, splitForDone, type DoneSplit, confirmable, lineNeedsVariant, removeLine, resolveClarification, setNote, setQuantity, setVariant, toCartLines, type Review } from "@/lib/voiceReview";

const LANGS: VoiceLang[] = ["auto", "en", "hi", "pa"];
const ERR_KEY: Record<VoiceErrorCode, Key> = {
  offline: "voice.offline", denied: "voice.denied", unsupported: "voice.unsupported", no_device: "voice.noDevice", too_short: "voice.tooShort",
  failed: "voice.failed", network: "voice.network", rate_limit: "voice.rateLimit", server: "voice.server", empty: "voice.empty", aborted: "voice.failed",
};
type Busy = "recording" | "processing" | null;

/**
 * Voice order sheet: hold-to-talk or type, then a REVIEW list. Nothing reaches the cart until "Add to cart" is tapped.
 * Voice needs the network; offline shows a message and queues nothing (manual ordering is unaffected).
 */
export function VoiceSheet({ onClose, onAdded }: { onClose: () => void; onAdded?: (a: { lines: CartLine[]; n: number; check: string[] }) => void }) {
  const t = useT();
  const online = useOnline();
  const { snap } = useMenu();
  const [view, setView] = useState<"talk" | "type" | "review">(() => (canRecord() ? "talk" : "type"));
  const [busy, setBusy] = useState<Busy>(null);
  const [err, setErr] = useState<VoiceErrorCode | null>(() => (canRecord() ? null : "unsupported"));
  const [denied, setDenied] = useState(false);
  const [lang, setLang] = useState<VoiceLang>("auto");
  const [text, setText] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [doneMsg, setDoneMsg] = useState<string | null>(null); // "done" was said but something is unresolved
  const rec = useRef<Recording | null>(null);
  const holding = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const langRef = useRef<VoiceLang>("auto");
  const dialog = useRef<HTMLDivElement>(null);

  useDialogFocus(dialog, onClose);
  useEffect(() => {
    let live = true;
    void micPermission().then((p) => { if (live && p === "denied") setDenied(true); });
    return () => { live = false; holding.current = false; rec.current?.cancel(); abort.current?.abort(); };
  }, [onClose]);

  const fail = useCallback((e: unknown) => {
    const code = e instanceof VoiceError ? e.code : "failed";
    if (code === "aborted") { setBusy(null); return; }
    if (code === "denied") setDenied(true);
    setBusy(null); setErr(code);
  }, []);

  const holdText = useCallback((h: DoneSplit["holds"][number], whole: boolean, n: number) => {
    const say = whole
      ? (h.kind === "choose_dish" ? t("voice.done.almost", { heard: h.heard }) : h.kind === "choose_option" ? t("voice.done.almostOption", { name: h.name ?? "" }) : t("voice.done.almostUnmatched", { heard: h.heard }))
      : t("voice.done.partial", { n, what: h.kind === "choose_dish" ? t("voice.done.whatDish", { heard: h.heard }) : h.kind === "choose_option" ? t("voice.done.whatOption", { name: h.name ?? "" }) : t("voice.done.whatUnmatched", { heard: h.heard }) });
    return say;
  }, [t]);

  /** "done" was said: everything clear goes into the cart (nothing is placed or sent); the rest stays here with the reason. */
  const finishDone = useCallback((rv: Review) => {
    const s = splitForDone(rv);
    if (s.cart.length) for (const l of s.cart) draftActions.add(l);
    if (s.cart.length) onAdded?.({ lines: s.cart, n: s.added, check: s.check });
    if (!s.holds.length && s.cart.length) { onClose(); return; }
    if (!s.cart.length && !s.holds.length) { setBusy(null); setErr("empty"); return; }
    setReview(s.cart.length ? s.rest : rv); setView("review"); setBusy(null);
    setDoneMsg(holdText(s.holds[0], !s.cart.length, s.added));
  }, [onAdded, onClose, holdText]);

  const dmenu = useMemo(() => doneMenuOf((snap?.items ?? []).filter((i) => i.is_active).map((i) => i.name)), [snap]);

  const run = useCallback(async (input: { audio?: Blob; text?: string }) => {
    setBusy("processing"); setErr(null); setDoneMsg(null);
    const ac = new AbortController(); abort.current = ac;
    try {
      if (!voiceProvider) throw new VoiceError("unsupported");
      let said = false;
      const base = { language: langRef.current, clientOpId: uuid(), menu: snap?.items };
      let resp;
      if (input.text !== undefined) {
        // "done" typed or said at the end is never sent to the parser (it is not a dish)
        const d = splitDone(input.text, dmenu); said = d.done;
        if (d.done && !d.rest.trim()) { setBusy(null); setErr("empty"); return; }
        resp = await voiceProvider.parse({ ...base, text: said ? d.rest : input.text }, ac.signal);
      } else {
        resp = await voiceProvider.parse({ ...base, ...input }, ac.signal);
        const d = splitDone(resp.transcript ?? "", dmenu);
        if (d.done) { // said in the recording: read the words again without it (so it is never part of a dish or a phrase)
          said = true;
          if (d.rest.trim()) { try { resp = { ...(await voiceProvider.parse({ ...base, clientOpId: uuid(), text: d.rest }, ac.signal)), transcript: d.rest }; } catch { /* keep the first reading */ } }
        }
      }
      resp = { ...resp, unmatched: (resp.unmatched ?? []).filter((u) => splitDone(u, dmenu).rest.trim()) };
      const rv = buildReview(resp, snap?.items ?? []);
      if (!rv.lines.length && !rv.clars.length && !rv.unmatched.length) { setBusy(null); setErr("empty"); return; }
      if (said) { finishDone(rv); return; }
      setReview(rv); setView("review"); setBusy(null);
    } catch (e) { fail(e); }
  }, [snap, fail, finishDone, dmenu]);

  async function press(e: PointerEvent<HTMLButtonElement>) {
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* unsupported */ }
    await start();
  }
  async function start() {
    if (busy || !online || denied) return;
    holding.current = true; setErr(null); setBusy("recording");
    try {
      const r = await startRecording(() => void release());
      if (!holding.current) { r.cancel(); setBusy(null); setErr("too_short"); return; }
      rec.current = r;
    } catch (x) { holding.current = false; fail(x); }
  }
  async function release() {
    if (!holding.current) return;
    holding.current = false;
    const r = rec.current; rec.current = null;
    if (!r) return; // released before the mic opened: press() reports "too short"
    setBusy("processing");
    try { await run({ audio: await r.stop() }); } catch (x) { fail(x); }
  }
  function onKey(e: KeyboardEvent<HTMLButtonElement>, down: boolean) {
    if (e.key !== " " && e.key !== "Enter") return;
    e.preventDefault();
    if (down && !e.repeat) void start();
    if (!down) void release();
  }

  function confirm() {
    if (!review || blocker(review)) return;
    for (const l of toCartLines(review)) draftActions.add(l);
    onClose();
  }
  const upd = (f: (r: Review) => Review) => setReview((r) => (r ? f(r) : r));

  const langChips = (
    <div className="chips" role="group" aria-label={t("voice.lang")}>
      {LANGS.map((l) => <button key={l} className="chip" aria-pressed={lang === l} onClick={() => { setLang(l); langRef.current = l; }}>{t(`voice.lang.${l}` as Key)}</button>)}
    </div>
  );
  const msg = !online ? "voice.offline" : err ? ERR_KEY[err] : denied ? "voice.denied" : null;

  return (
    <div className="sheet" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={t("voice.title")} tabIndex={-1} ref={dialog} className="voicesheet" onClick={(e) => e.stopPropagation()}>
        <h2 className="voicesheet-title">{view === "review" ? t("voice.review") : t("voice.title")}</h2>
        <div className="voicesheet-body">
        {msg && <div className="banner err" role="alert">{t(msg, { s: 60 })}{err && online && !denied && view !== "review" && err !== "empty" && err !== "too_short" && <> <button className="btn" onClick={() => setErr(null)}>{t("voice.retry")}</button></>}</div>}
        {view === "talk" && (
          <>
            {langChips}
            <button className={`mic${busy === "recording" ? " live" : ""}`} disabled={!online || denied || busy === "processing"}
              aria-label={t("voice.hold")} onPointerDown={(e) => void press(e)} onPointerUp={() => void release()} onPointerCancel={() => void release()}
              onContextMenu={(e) => e.preventDefault()} onKeyDown={(e) => onKey(e, true)} onKeyUp={(e) => onKey(e, false)}>
              {busy === "recording" ? t("voice.release") : busy === "processing" ? t("voice.processing") : t("voice.hold")}
            </button>
            <p className="muted small" role="status" aria-live="polite">{busy === "recording" ? t("voice.listening") : t("voice.holdHint")}</p>
            <div className="row">
              <button className="btn grow" onClick={() => { setView("type"); setErr(null); }}>{t("voice.typeInstead")}</button>
              <button className="btn grow" onClick={onClose}>{t("voice.close")}</button>
            </div>
          </>
        )}
        {view === "type" && (
          <>
            {langChips}
            <label className="field"><span>{t("voice.typeLabel")}</span>
              <textarea className="input" lang={lang === "auto" ? undefined : lang} maxLength={500} value={text} placeholder={t("voice.typePlaceholder")} onChange={(e) => setText(e.target.value)} /></label>
            {busy === "processing" && <p className="muted" role="status">{t("voice.processing")}</p>}
            <div className="row">
              {canRecord() && <button className="btn grow" onClick={() => { setView("talk"); setErr(null); }}>{t("voice.speakInstead")}</button>}
              <button className="btn primary grow" disabled={!online || busy === "processing" || !text.trim()} onClick={() => void run({ text })}>{t("voice.send")}</button>
            </div>
            <button className="btn block" style={{ marginTop: 10 }} onClick={onClose}>{t("voice.close")}</button>
          </>
        )}
        {view === "review" && review && (
          <>
            <p className="muted small">{t("voice.reviewHint")}{review.transcript ? ` ${t("voice.heard", { text: review.transcript })}` : ""}</p>
            {review.clars.map((c) => (
              <div className="card" key={c.id} role="group" aria-label={t("voice.clarify", { heard: c.heard })}>
                <strong>{t("voice.clarify", { heard: c.heard })}</strong> <span className="muted">x{c.quantity}</span>
                <div className="chips" style={{ flexWrap: "wrap", marginTop: 8 }}>
                  {c.options.map((o, i) => <button key={`${o.item_id}-${o.variant_id ?? ""}`} className="chip" onClick={() => upd((r) => resolveClarification(r, c.id, i))}>{o.item.name}{o.variant_name ? ` · ${o.variant_name}` : ""}</button>)}
                </div>
              </div>
            ))}
            {review.lines.map((l) => (
              <div className="card" key={l.id} style={lineNeedsVariant(l) || l.issues.length ? { borderColor: "var(--warn-fg)" } : undefined}>
                <div className="row between">
                  <div className="grow">
                    <strong>{l.itemName}</strong>
                    {l.item && l.variantId && <span className="muted"> · {l.item.variants.find((v) => v.id === l.variantId)?.name}</span>}
                    {l.item && <div className="small">{formatMoney(mulDecimal(makeLine(l.item, l.variantId, l.quantity, "").unit_price, l.quantity))}</div>}
                    {heardToShow(l).length > 0 && <div className="small muted" data-testid="voice-heard">{t("voice.heard", { text: heardToShow(l).join(" / ") })}</div>}
                    {l.checkDish && <div><span className="pill pending" data-testid="voice-check-dish">{t("voice.checkDish")}</span></div>}
                    {l.issues.filter((i) => !(l.checkDish && i === "needs_review")).map((i) => <div key={i} className="small" style={{ color: "var(--warn-fg)" }}>{t(`voice.issue.${i}` as Key) === `voice.issue.${i}` ? i : t(`voice.issue.${i}` as Key)}</div>)}
                  </div>
                  {l.item && (
                    <div className="qty" role="group" aria-label={t("voice.qty", { name: l.itemName })}>
                      <button className="btn" aria-label="-" onClick={() => upd((r) => setQuantity(r, l.id, l.quantity - 1))}>-</button>
                      <output>{l.quantity}</output>
                      <button className="btn" aria-label="+" onClick={() => upd((r) => setQuantity(r, l.id, l.quantity + 1))}>+</button>
                    </div>
                  )}
                </div>
                {l.item && l.item.variants.length > 0 && (
                  <div className="chips" style={{ flexWrap: "wrap", marginTop: 8 }} role="group" aria-label={t("voice.chooseOption")}>
                    {l.item.variants.map((v) => <button key={v.id} className="chip" aria-pressed={l.variantId === v.id} onClick={() => upd((r) => setVariant(r, l.id, v.id))}>{v.name}</button>)}
                  </div>
                )}
                {l.item && <input className="input" style={{ marginTop: 8 }} aria-label={t("voice.note")} placeholder={t("voice.note")} value={l.note} onChange={(e) => upd((r) => setNote(r, l.id, e.target.value))} />}
                <button className="btn" style={{ marginTop: 8 }} onClick={() => upd((r) => removeLine(r, l.id))}>{t("voice.remove")}</button>
              </div>
            ))}
            {review.unmatched.map((u) => <div className="banner" key={u}>{t("voice.unmatched", { text: u })}</div>)}
            {doneMsg && <div className="banner" role="status" data-testid="voice-done-hold">{doneMsg}</div>}
            {blocker(review) === "resolve" && <div className="banner" role="status">{t("voice.resolveFirst")}</div>}
          </>
        )}
        </div>
        {view === "review" && review && (
          <div className="row voicesheet-foot">
            <button className="btn grow" onClick={onClose}>{t("voice.cancel")}</button>
            <button className="btn grow" onClick={() => { setReview(null); setView("talk"); }}>{t("voice.retry")}</button>
            <button className="btn primary grow" disabled={!!blocker(review)} onClick={confirm}>{confirmable(review) ? t("voice.confirm", { n: confirmable(review) }) : t("voice.confirmNone")}</button>
          </div>
        )}
      </div>
    </div>
  );
}
