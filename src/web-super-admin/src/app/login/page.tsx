"use client";
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button, Checkbox, Input, PasswordInput, icons } from "@chilli/ui";
import { AuthSplit, useRememberedEmail } from "@chilli/ui/auth";
import { brandCopy } from "@chilli/tokens";
import { ApiError, sessionHttp } from "@/lib/api";
import type { LoginResult, MfaEnrolDone, MfaEnrolStart } from "@/lib/api/types";
import { useSession } from "@/lib/session";
import { InlineError, Notice } from "@/components/ui";
import { MfaEnrol } from "@/components/MfaEnrol";
import { authMedia } from "@/lib/auth-media";

import { PillLogo, Wordmark } from "@/components/Brand";

interface Mode { mode: "mock" | "live"; demo?: { password: string; accounts: { email: string; role: string }[] } }
type Step = "password" | "verify" | "enrol";

export default function LoginPage() {
  const { state, signIn, adopt } = useSession();
  const router = useRouter();
  const { email, setEmail, remember, setRemember, commit } = useRememberedEmail("hq.rememberEmail");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError>();
  const [mode, setMode] = useState<Mode>();
  const [step, setStep] = useState<Step>("password");
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);

  useEffect(() => { if (state.status === "authed" && step === "password") router.replace("/"); }, [state.status, step, router]);
  useEffect(() => { fetch("/api/session/mode", { cache: "no-store" }).then((r) => r.json()).then(setMode, () => undefined); }, []);

  const fail = (err: unknown) => setError(err instanceof ApiError ? err : new ApiError(0, "unknown", "Something went wrong"));
  const finish = (r: Extract<LoginResult, { status: "signed_in" }>) => { adopt(r.user); router.replace(r.must_change_password ? "/account" : "/"); };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email || !password) { setError(new ApiError(422, "validation_error", "Enter your email and password")); return; }
    setBusy(true); setError(undefined);
    try {
      const r = await signIn(email.trim(), password);
      commit(email.trim());
      if (r.status === "signed_in") router.replace(r.must_change_password ? "/account" : "/");
      else { setPassword(""); setStep(r.status === "mfa_verify" ? "verify" : "enrol"); }
    } catch (err) { fail(err); } finally { setBusy(false); }
  };

  const verify = async (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim()) { setError(new ApiError(422, "validation_error", useRecovery ? "Enter a recovery code" : "Enter the 6-digit code")); return; }
    setBusy(true); setError(undefined);
    try { finish(await sessionHttp.post<Extract<LoginResult, { status: "signed_in" }>>("/mfa/verify", useRecovery ? { recovery_code: code } : { code })); }
    catch (err) { fail(err); if (err instanceof ApiError && err.status === 401 && err.message.includes("expired")) setStep("password"); } finally { setBusy(false); }
  };

  const back = () => { setStep("password"); setCode(""); setError(undefined); };

  const title = step === "password" ? "Sign In" : step === "verify" ? "Two-step verification" : "Set up two-step verification";
  const subtitle = step === "password" ? "Sign in with your TheChilli.ai Super Admin staff account."
    : step === "verify" ? (useRecovery ? "Enter one of your recovery codes. Each works once." : "Enter the 6-digit code from your authenticator app.")
    : undefined;

  return (
    <AuthSplit
      logo={<Wordmark height={36} />}
      title={title}
      subtitle={subtitle}
      media={authMedia}
      shapeLogo={<PillLogo />}
      headline="Super Admin"
      tagline={brandCopy.tagline}
    >
      {mode?.mode === "mock" && step === "password" ? <Notice tone="warning" title="Demo mode.">Data is fake and resets on restart. Try {mode.demo?.accounts.map((a) => a.email).join(", ")} with password <code>{mode.demo?.password}</code>.</Notice> : null}
      {step === "password" ? (
        <form onSubmit={submit} noValidate>
          <Input variant="pill" icon={icons.mail} label="Email" type="email" autoComplete="username" placeholder="Enter your email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          <PasswordInput variant="pill" label="Password" autoComplete="current-password" placeholder="Enter your password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <div className="ch-auth__row"><Checkbox label="Remember me" checked={remember} onChange={(e) => setRemember(e.target.checked)} /></div>
          <InlineError error={error} />
          <Button type="submit" variant="primary" size="lg" loading={busy}>Sign in</Button>
        </form>
      ) : step === "verify" ? (
        <form className="hq-stack" onSubmit={verify} noValidate>
          <Input variant="pill" label={useRecovery ? "Recovery code" : "6-digit code"} inputMode={useRecovery ? "text" : "numeric"} autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
          <InlineError error={error} />
          <Button type="submit" variant="primary" size="lg" loading={busy}>Verify</Button>
          <div className="hq-row" style={{ justifyContent: "center" }}>
            <Button type="button" onClick={() => { setUseRecovery(!useRecovery); setCode(""); setError(undefined); }}>{useRecovery ? "Use authenticator code" : "Use a recovery code"}</Button>
            <Button type="button" onClick={back}>Back</Button>
          </div>
        </form>
      ) : (
        <div className="hq-stack">
          <Notice tone="warning">Your role requires two-step verification. Set it up to finish signing in.</Notice>
          <MfaEnrol
            start={() => sessionHttp.post<MfaEnrolStart>("/mfa/enrol/start")}
            confirm={(c) => sessionHttp.post<MfaEnrolDone>("/mfa/enrol/confirm", { code: c })}
            onFinished={(d) => { if (d.user) finish({ status: "signed_in", user: d.user, must_change_password: !!d.must_change_password }); else back(); }}
            finishLabel="Continue to HQ" />
          <div><Button type="button" onClick={back}>Cancel</Button></div>
        </div>
      )}
    </AuthSplit>
  );
}
