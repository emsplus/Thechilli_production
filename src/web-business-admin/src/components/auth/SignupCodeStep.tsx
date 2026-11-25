"use client";

import { Button, Notice } from "@chilli/ui";
import { useEffect, useId, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from "react";
import { api, type SessionGrant } from "@/lib/api";
import { clockNow, CODE_LENGTH, DEFAULT_RESEND_SECONDS, emptyCode, fillCode, formatWait, isComplete, resendError, verifyErrorMessage } from "@/lib/signupCode";

/** Absolute times (ms) of a pending sign-up, kept by the page so a reload (phone switching to the mail app) keeps the step. */
export interface CodeClock { expiresAt: number; resendAt: number }

/**
 * Second sign-up step (pos-service docs/EMAIL.md): "Enter the code we emailed you". Six one-digit boxes (paste / autofill
 * anywhere fills them all, typing moves on, Backspace moves back; numeric keyboard on phones), auto-submits the full code,
 * resend with a countdown seeded by the server (Retry-After on 429), and one message for every bad code that points at
 * Resend code, because the API deliberately answers wrong, expired and used-up codes with the same 400.
 */
export function SignupCodeStep({ email, clock, expiresInSeconds, onClockChange, onVerified, onBack }: {
  email: string;
  clock: CodeClock;
  /** Lifetime of a fresh code (from the 202), applied again after a resend. */
  expiresInSeconds: number;
  onClockChange: (c: CodeClock) => void;
  onVerified: (session: SessionGrant) => void;
  onBack: () => void;
}) {
  const uid = useId().replace(/:/g, "");
  const [boxes, setBoxes] = useState<string[]>(emptyCode);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [resendErr, setResendErr] = useState<string | null>(null); // shown by the resend button: not a problem with the typed code
  const [now, setNow] = useState(() => clockNow());
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  const resendIn = Math.max(0, Math.ceil((clock.resendAt - now) / 1000));
  const expired = now >= clock.expiresAt;

  // One clock for the resend countdown and the code's expiry; stops once both are in the past.
  useEffect(() => {
    if (resendIn <= 0 && expired) return;
    const t = setInterval(() => setNow(clockNow()), 1000);
    return () => clearInterval(t);
  }, [resendIn, expired]);

  useEffect(() => { refs.current[0]?.focus(); }, []);

  const focusBox = (i: number) => { const el = refs.current[Math.max(0, Math.min(CODE_LENGTH - 1, i))]; el?.focus(); el?.select(); };

  async function verify(code: string) {
    if (busy) return;
    setBusy(true); setError(null); setInfo(null);
    try {
      onVerified(await api.verifyEmail(email, code));
    } catch (e) {
      setError(verifyErrorMessage(e));
      setBoxes(emptyCode());
      setBusy(false);
      setTimeout(() => focusBox(0), 0);
    }
  }

  function put(i: number, input: string) {
    const r = fillCode(boxes, i, input);
    setBoxes(r.boxes);
    if (error) setError(null);
    if (isComplete(r.boxes)) void verify(r.boxes.join(""));
    else focusBox(r.focus);
  }

  function onKey(i: number, e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace" && !boxes[i] && i > 0) {
      e.preventDefault();
      setBoxes((b) => b.map((d, j) => (j === i - 1 ? "" : d)));
      focusBox(i - 1);
    } else if (e.key === "ArrowLeft") { e.preventDefault(); focusBox(i - 1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); focusBox(i + 1); }
  }

  function onPaste(i: number, e: ClipboardEvent<HTMLInputElement>) {
    e.preventDefault();
    put(i, e.clipboardData.getData("text"));
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (isComplete(boxes)) void verify(boxes.join(""));
    else { setError(`Enter all ${CODE_LENGTH} digits of the code.`); focusBox(boxes.findIndex((b) => !b)); }
  }

  async function resend() {
    setSending(true); setResendErr(null); setInfo(null);
    try {
      const r = await api.resendVerifyEmail(email);
      const t = clockNow();
      onClockChange({ resendAt: t + (r.resend_after_seconds ?? DEFAULT_RESEND_SECONDS) * 1000, expiresAt: t + expiresInSeconds * 1000 });
      setNow(t);
      setBoxes(emptyCode()); setError(null);
      setInfo("A new code is on its way. Use the code in the newest email; earlier codes stop working.");
      focusBox(0);
    } catch (e) {
      const r = resendError(e);
      setResendErr(r.message);
      if (r.wait) { const t = clockNow(); setNow(t); onClockChange({ ...clock, resendAt: t + r.wait * 1000 }); }
    } finally { setSending(false); }
  }

  const errId = `${uid}-err`, hintId = `${uid}-hint`;
  return (
    <div className="grid gap-5">
      <p className="text-sm text-fg-muted">
        We sent a {CODE_LENGTH}-digit code to <strong className="break-all text-fg" data-testid="signup-code-email">{email}</strong>.{" "}
        <button type="button" onClick={onBack} className="font-medium text-primary underline underline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          Wrong email? Go back
        </button>
      </p>

      <div role="status" aria-live="polite">{info && <Notice tone="success">{info}</Notice>}</div>
      {expired && !error && <Notice tone="warning">This code has expired. Tap Resend code to get a new one.</Notice>}

      <form noValidate onSubmit={submit} className="grid gap-4">
        <fieldset aria-describedby={error ? errId : hintId} className="m-0 min-w-0 border-0 p-0">
          <legend className="ch-label mb-2">Enter the {CODE_LENGTH}-digit code</legend>
          <div className="grid grid-cols-6 gap-2 sm:gap-3">
            {boxes.map((d, i) => (
              <input key={i} ref={(el) => { refs.current[i] = el; }} value={d}
                aria-label={`Digit ${i + 1} of ${CODE_LENGTH}`} aria-invalid={error ? true : undefined}
                aria-describedby={error ? errId : undefined}
                inputMode="numeric" pattern="[0-9]*" autoComplete={i === 0 ? "one-time-code" : "off"} enterKeyHint={i === CODE_LENGTH - 1 ? "done" : "next"}
                disabled={busy}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => put(i, e.target.value)}
                onKeyDown={(e) => onKey(i, e)}
                onPaste={(e) => onPaste(i, e)}
                className="h-14 w-full min-w-0 rounded-xl border border-border-strong bg-surface text-center text-2xl font-semibold tabular-nums text-fg shadow-[inset_0_1px_2px_rgb(60_35_15/0.04)] transition-[border-color,box-shadow] duration-150 focus:border-ring focus:outline-none focus:ring-4 focus:ring-ring/15 disabled:opacity-60 aria-[invalid=true]:border-danger aria-[invalid=true]:focus:ring-danger/25" />
            ))}
          </div>
          {error
            ? <p className="ch-error mt-2" id={errId} role="alert">{error}</p>
            : <p className="ch-hint mt-2" id={hintId}>The code works for {Math.round(expiresInSeconds / 60)} minutes. Not in your inbox? Check the spam folder.</p>}
        </fieldset>
        <Button variant="primary" type="submit" size="lg" loading={busy}>Verify code</Button>
      </form>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-muted">
        <span>Did not get it?</span>
        <Button variant="secondary" onClick={resend} loading={sending} disabled={resendIn > 0 || busy}
          aria-describedby={resendIn > 0 ? `${uid}-wait` : undefined}>
          Resend code
        </Button>
        {resendIn > 0 && <span id={`${uid}-wait`} className="tabular-nums">You can ask again in {formatWait(resendIn)}</span>}
        {resendErr && <p className="ch-error w-full" role="alert">{resendErr}</p>}
      </div>
    </div>
  );
}
