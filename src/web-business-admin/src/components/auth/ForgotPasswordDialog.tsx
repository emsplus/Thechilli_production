"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { CheckCircle2, MailCheck, KeyRound, ServerCog, UserCog } from "lucide-react";
import { Button, Dialog, Input, Notice } from "@chilli/ui";
import { ApiError } from "@/lib/api";
import { useMsg } from "@/lib/i18n";
import { AUTH_MSG } from "./messages";
import { fieldError } from "./validation";
import { PasswordInput } from "./fields";
import { emailSchema, resetSchema, resetUnsupported } from "@/lib/passwords";
import { CODE_LENGTH, RESEND_SECONDS, ResetError, cleanCode, formatCountdown, isFullCode, policyMessage, resetApi } from "@/lib/passwordReset";

/** Texts of the code flow. English only (docs/DECISIONS.md 2026-10-31), so they are plain strings, not a translated catalog. */
const TXT = {
  desc: "Enter your email. We will send a 6-digit code to set a new password.",
  sendCode: "Email me a code",
  codeSent: (email: string) => `If an account exists for ${email}, we have emailed a 6-digit code. It works for 10 minutes. Check your spam folder too.`,
  codeLabel: "6-digit code",
  verify: "Check code",
  resendIn: (s: string) => `Resend code in ${s}`,
  resend: "Resend code",
  resent: "A new code is on its way.",
  otherEmail: "Use a different email",
  haveCode: "I have a code",
  wrongCode: "That code is wrong or has expired. Check the latest email or ask for a new code.",
  codeIncomplete: `Enter all ${CODE_LENGTH} digits`,
  tooManyWait: (s: string) => `Too many tries. Please wait ${s} and try again.`,
  pwStep: "Code accepted. Choose a new password of at least 10 characters. You will be signed out on every device.",
  sessionExpired: "This reset took too long or was already used. Please start again.",
  startAgain: "Start again",
  done: "Your password is changed and you were signed out everywhere. Sign in with the new password.",
  close: "Close",
};

type Step = { s: "email" } | { s: "link"; email: string } | { s: "code"; email: string } | { s: "password"; email: string; token: string } | { s: "done" };

/** ms epoch `sec` seconds from now (outside the component: only event handlers call it). */
const deadline = (sec: number) => Date.now() + sec * 1000;

/** Ticks once a second until `until` (ms epoch); returns the seconds left (0 = can resend). */
function useCountdown(until: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until <= Date.now()) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [until]);
  return Math.max(0, Math.ceil((until - now) / 1000));
}

/** Renders `<b>..</b>` and `<c>..</c>` (code) markers used in a few catalog texts. */
function rich(text: string): ReactNode[] {
  return text.split(/(<b>.*?<\/b>|<c>.*?<\/c>)/).map((part, i) => {
    const b = /^<b>(.*)<\/b>$/.exec(part);
    if (b) return <strong key={i}>{b[1]}</strong>;
    const c = /^<c>(.*)<\/c>$/.exec(part);
    if (c) return <code key={i} className="rounded bg-surface-2 px-1">{c[1]}</code>;
    return part;
  });
}

const linkBtn = "inline-flex min-h-11 items-center text-sm font-semibold text-primary-soft-fg underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:text-fg-subtle disabled:no-underline";

/**
 * Forgot password, as a few short steps (pos-service docs/EMAIL.md "Password reset (PASSWORD_RESET_MODE=otp)"):
 * email -> 6-digit code (resend after a countdown) -> new password -> done. The first answer is always the same 200 (no account
 * enumeration), so the screen says "if an account exists". A server still in link mode answers "a reset link has been sent": the old
 * "check your email" message is shown, with "I have a code" in case. A server without the route (404 / 405 / 501) falls back to
 * the guidance below, which is always shown.
 */
export function ForgotPasswordForm({ onDone }: { onDone?: () => void }) {
  const t = useMsg(AUTH_MSG);
  const [step, setStep] = useState<Step>({ s: "email" });
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [resendAt, setResendAt] = useState(0);
  const left = useCountdown(resendAt);
  const wait = (sec: number) => setResendAt(deadline(sec));

  const emailForm = useForm<{ email: string }>({ resolver: zodResolver(emailSchema) });
  const pwForm = useForm<{ next: string; again: string }>({ resolver: zodResolver(resetSchema), defaultValues: { next: "", again: "" } });
  const [code, setCode] = useState("");
  const [codeErr, setCodeErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const common = (e: unknown): string => {
    if (e instanceof ResetError && e.status === 429) { if (e.retryAfter) wait(e.retryAfter); return TXT.tooManyWait(formatCountdown(e.retryAfter ?? RESEND_SECONDS)); }
    if (e instanceof ApiError && e.status === 0) return t("offline");
    return t("genericError");
  };

  async function request(email: string, again = false) {
    setError(null); setInfo(null); setUnsupported(false);
    try {
      const r = await resetApi.request(email);
      wait(r.resendAfter);
      if (again) setInfo(TXT.resent);
      setStep(r.mode === "otp" ? { s: "code", email } : { s: "link", email });
    } catch (e) {
      if (resetUnsupported(e)) setUnsupported(true);
      else if (e instanceof ResetError && e.status === 429) { if (e.retryAfter) wait(e.retryAfter); setError(again ? TXT.tooManyWait(formatCountdown(e.retryAfter ?? RESEND_SECONDS)) : t("tooManyReq")); }
      else if (e instanceof ApiError && e.status === 0) setError(t("offline"));
      else setError(t("sendFail"));
    }
  }

  async function verify(email: string) {
    if (!isFullCode(code)) { setCodeErr(TXT.codeIncomplete); return; }
    setCodeErr(null); setError(null); setInfo(null); setBusy(true);
    try { const r = await resetApi.verify(email, code); setStep({ s: "password", email, token: r.reset_token }); }
    catch (e) { if (e instanceof ApiError && (e.status === 400 || e.status === 422)) setCodeErr(TXT.wrongCode); else setError(common(e)); }
    finally { setBusy(false); }
  }

  const restart = () => { setStep({ s: "email" }); setCode(""); setCodeErr(null); setError(null); setInfo(null); pwForm.reset(); };
  const errorBox = error && <Notice tone="danger">{error}</Notice>;

  if (step.s === "done") return (
    <div className="space-y-3" data-testid="reset-done">
      <Notice tone="success"><span><CheckCircle2 aria-hidden className="mr-1 inline size-4" />{TXT.done}</span></Notice>
      {onDone && <Button variant="primary" className="w-full" onClick={onDone}>{t("goToLogin")}</Button>}
    </div>
  );

  if (step.s === "password") return (
    <form noValidate className="space-y-3" data-testid="reset-password-step" onSubmit={pwForm.handleSubmit(async (v) => {
      setError(null);
      try { await resetApi.complete(step.email, step.token, v.next); setStep({ s: "done" }); }
      catch (e) {
        if (e instanceof ApiError && e.status === 400) setError(TXT.sessionExpired);
        else if (e instanceof ApiError && e.status === 422) pwForm.setError("next", { message: policyMessage(e.message) || t("pwNotAllowed") });
        else setError(common(e));
      }
    })}>
      <p className="text-sm text-fg-muted">{TXT.pwStep}</p>
      <PasswordInput label={t("newPassword")} autoComplete="new-password" error={fieldError(t, pwForm.formState.errors.next?.message)} {...pwForm.register("next")} />
      <PasswordInput label={t("newPasswordAgain")} autoComplete="new-password" error={fieldError(t, pwForm.formState.errors.again?.message)} {...pwForm.register("again")} />
      {errorBox}
      {error === TXT.sessionExpired && <button type="button" className={linkBtn} onClick={restart}>{TXT.startAgain}</button>}
      <Button type="submit" variant="primary" loading={pwForm.formState.isSubmitting} className="w-full">{t("changePassword")}</Button>
    </form>
  );

  if (step.s === "code") return (
    <form noValidate className="space-y-3" data-testid="reset-code-step" onSubmit={(e) => { e.preventDefault(); void verify(step.email); }}>
      <Notice tone="success"><span data-testid="forgot-sent"><MailCheck aria-hidden className="mr-1 inline size-4" />{TXT.codeSent(step.email)}</span></Notice>
      <Input label={TXT.codeLabel} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={CODE_LENGTH + 2} autoFocus
        className="tnum text-center font-mono text-xl tracking-[0.4em]" value={code} error={codeErr ?? undefined}
        onChange={(e) => { setCode(cleanCode(e.target.value)); setCodeErr(null); }} />
      {errorBox}
      {info && <p role="status" className="text-sm text-fg-muted">{info}</p>}
      <Button type="submit" variant="primary" loading={busy} className="w-full">{TXT.verify}</Button>
      <div className="flex flex-wrap items-center justify-between gap-x-4">
        <button type="button" className={linkBtn} disabled={left > 0} onClick={() => void request(step.email, true)}>
          {left > 0 ? <span className="tnum" aria-live="off">{TXT.resendIn(formatCountdown(left))}</span> : TXT.resend}
        </button>
        <button type="button" className={linkBtn} onClick={restart}>{TXT.otherEmail}</button>
      </div>
    </form>
  );

  return (
    <form noValidate className="space-y-3" onSubmit={emailForm.handleSubmit(({ email }) => request(email.trim()))}>
      <Input label={t("yourEmail")} type="email" autoComplete="username" placeholder="you@example.com" error={fieldError(t, emailForm.formState.errors.email?.message)} {...emailForm.register("email")} />
      {errorBox}
      {step.s === "link" && <Notice tone="success"><span data-testid="forgot-sent"><MailCheck aria-hidden className="mr-1 inline size-4" />{t("sent")}</span></Notice>}
      {unsupported && <Notice tone="info">{t("unsupported")}</Notice>}
      <Button type="submit" variant="primary" loading={emailForm.formState.isSubmitting} className="w-full">{TXT.sendCode}</Button>
      {step.s === "link" && <button type="button" className={linkBtn} onClick={() => setStep({ s: "code", email: step.email })}>{TXT.haveCode}</button>}
    </form>
  );
}

export function ResetGuidance() {
  const t = useMsg(AUTH_MSG);
  return (
    <ul className="space-y-3 text-sm">
      <li className="flex gap-3 rounded-xl bg-surface-2/70 p-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary-soft-fg"><UserCog className="size-[1.1rem]" aria-hidden /></span>
        <span><strong className="block text-fg">{t("guideStaffTitle")}</strong><span className="text-fg-muted">{rich(t("guideStaffBody"))}</span></span>
      </li>
      <li className="flex gap-3 rounded-xl bg-surface-2/70 p-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary-soft-fg"><ServerCog className="size-[1.1rem]" aria-hidden /></span>
        <span><strong className="block text-fg">{t("guideOwnerTitle")}</strong><span className="text-fg-muted">{rich(t("guideOwnerBody"))}</span></span>
      </li>
      <li className="flex items-center gap-2 px-1 text-xs text-fg-subtle"><KeyRound className="size-3.5" aria-hidden />{t("lockNote")}</li>
    </ul>
  );
}

/** Heading and intro of the /forgot-password page. */
export function ForgotPageIntro() {
  const t = useMsg(AUTH_MSG);
  return (
    <div>
      <h1 className="font-display text-3xl font-extrabold tracking-tight text-fg">{t("forgotTitle")}</h1>
      <p className="mt-2 text-sm text-fg-muted">{TXT.desc}</p>
    </div>
  );
}

export function BackToLoginText() {
  const t = useMsg(AUTH_MSG);
  return <>{t("backToLogin")}</>;
}

export function ForgotPasswordDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const t = useMsg(AUTH_MSG);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t("forgotTitle")}
      description={TXT.desc}
      footer={<Button onClick={() => onOpenChange(false)}>{TXT.close}</Button>}>
      <div className="space-y-4 py-2">
        {/* Remounted on every open: a half-finished reset never reappears. */}
        {open && <ForgotPasswordForm onDone={() => onOpenChange(false)} />}
        <ResetGuidance />
      </div>
    </Dialog>
  );
}
