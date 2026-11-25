"use client";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { Button, Dialog, Input } from "@chilli/ui";
import { api } from "@/lib/api";
import { stepUpCoordinator } from "@/lib/step-up-coordinator";
import { classifyStepUpError, cleanCode, codeProblem, describeAction, formatWait, grantFromResponse, type CodeMode, type StepUpFailure, type StepUpGrant } from "@/lib/step-up";

/**
 * The one app-wide "Confirm with your code" dialog. Mounted once in <Providers>; registers itself with the step-up coordinator,
 * which opens it when platform-core answers a protected action with 403 step_up_required (and never opens two at once).
 * The grant it obtains is handed straight back to the coordinator for the repeated request: it is never rendered, stored in
 * a cookie, localStorage or sessionStorage, or kept in React state after the dialog closes.
 */
export function StepUpHost() {
  const [req, setReq] = useState<{ key: string } | null>(null);
  const resolveRef = useRef<((g: StepUpGrant | null) => void) | null>(null);

  const finish = (g: StepUpGrant | null) => { resolveRef.current?.(g); resolveRef.current = null; setReq(null); };
  useEffect(() => {
    stepUpCoordinator.setPrompter(
      ({ key }) => new Promise((resolve) => { resolveRef.current = resolve; setReq({ key }); }),
      // Session ended (sign-out, expired, 401) while the dialog was open: nothing to confirm any more.
      () => { resolveRef.current?.(null); resolveRef.current = null; setReq(null); },
    );
    return () => stepUpCoordinator.setPrompter(null);
  }, []);

  if (!req) return null;
  const sp = req.key.indexOf(" ");
  return <StepUpDialog action={describeAction(req.key.slice(0, sp), req.key.slice(sp + 1))} onDone={finish} />;
}

function useSecondsLeft(until: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until <= Date.now()) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  return Math.max(0, Math.ceil((until - now) / 1000));
}

function StepUpDialog({ action, onDone }: { action: string; onDone: (g: StepUpGrant | null) => void }) {
  const formId = useId();
  const field = useRef<HTMLInputElement>(null);
  const focusField = () => setTimeout(() => field.current?.focus(), 0);
  const [mode, setMode] = useState<CodeMode>("totp");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<StepUpFailure>();
  const [lockedUntil, setLockedUntil] = useState(0);
  const left = useSecondsLeft(lockedUntil);
  const locked = lockedUntil > 0 && left > 0;
  const recovery = mode === "recovery";
  const notEnrolled = fail?.kind === "not_enrolled";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || locked) return;
    const problem = codeProblem(code, mode);
    if (problem) { setFail({ kind: "wrong_code", message: problem }); focusField(); return; }
    setBusy(true); setFail(undefined);
    try {
      onDone(grantFromResponse(await api.auth.stepUp(code)));
    } catch (err) {
      const f = classifyStepUpError(err, mode);
      setFail(f); setBusy(false);
      if (f.kind === "locked") setLockedUntil(Date.now() + f.retryAfterSeconds * 1000);
      if (f.kind === "wrong_code") { setCode(""); focusField(); }
      if (f.kind === "session") onDone(null);
    }
  };

  const switchMode = () => { setMode(recovery ? "totp" : "recovery"); setCode(""); setFail(undefined); focusField(); };
  const fieldError = fail?.kind === "wrong_code" ? fail.message : undefined;
  const banner = fail && fail.kind !== "wrong_code" && fail.kind !== "not_enrolled" ? fail : undefined;

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onDone(null); }} title="Confirm with your code"
      description={notEnrolled ? `${action}.` : `${action}. ${recovery ? "Enter one of your recovery codes. Each works once." : "Enter the 6-digit code from your authenticator app."}`}
      footer={notEnrolled ? (
        <>
          <Button onClick={() => onDone(null)}>Cancel</Button>
          <Link className="ch-btn ch-btn--primary ch-btn--md" href="/account/security" onClick={() => onDone(null)}>Open Account security</Link>
        </>
      ) : (
        <>
          <Button onClick={() => onDone(null)} disabled={busy}>Cancel</Button>
          <Button type="submit" form={formId} variant="primary" loading={busy} disabled={locked}>{locked ? `Try again in ${formatWait(left)}` : "Confirm"}</Button>
        </>
      )}>
      {notEnrolled ? (
        <div className="hq-stack">
          <p className="hq-inline-error" role="alert">{fail.message}</p>
          <p className="hq-sub">Set up an authenticator app in Account security, then repeat this action.</p>
        </div>
      ) : (
        <form id={formId} className="hq-stack" onSubmit={submit} noValidate>
          <Input ref={field} label={recovery ? "Recovery code" : "6-digit code"} className="hq-code" name="step-up-code"
            inputMode={recovery ? "text" : "numeric"} autoComplete="one-time-code" autoCapitalize={recovery ? "characters" : "off"} autoCorrect="off" spellCheck={false}
            pattern={recovery ? undefined : "[0-9]*"} maxLength={recovery ? 48 : 12} /* room for a pasted "123 456"; cleanCode() keeps 6 digits */ value={code} readOnly={busy}
            onChange={(e) => { setCode(cleanCode(e.target.value, mode)); if (fail?.kind === "wrong_code") setFail(undefined); }}
            hint={recovery ? "For example ABCDE-FGHJK-LMNPQ." : "Changes every 30 seconds."} error={fieldError} />
          {banner ? <p className="hq-inline-error" role="alert">{banner.kind === "locked" ? `${banner.message} Try again in ${formatWait(banner.retryAfterSeconds)}.` : banner.message}</p> : null}
          <div>
            <Button type="button" variant="ghost" size="sm" onClick={switchMode} disabled={busy}>{recovery ? "Use authenticator code" : "Use a recovery code"}</Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
