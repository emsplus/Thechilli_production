"use client";
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, Checkbox, Input, PasswordInput, icons } from "@chilli/ui";
import { AuthSplit, useRememberedEmail } from "@chilli/ui/auth";
import { useAuth } from "@/components/auth";
import { FormError } from "@/components/ui";
import { useAction } from "@/lib/hooks";
import { MOCK_MODE } from "@/lib/api";
import { safeNext } from "@/lib/return-to";
import { DEMO_LOGINS } from "@/mocks/accounts";
import { authMedia } from "@/lib/auth-media";

import { PillLogo, Wordmark } from "@/components/brand";
import { brandCopy } from "@chilli/tokens";

export default function LoginPage() {
  const { login, status } = useAuth();
  const router = useRouter();
  const { email, setEmail, remember, setRemember, commit } = useRememberedEmail("mkt.rememberEmail");
  const [password, setPassword] = useState("");
  const { busy, error, run } = useAction();

  const back = () => safeNext(new URLSearchParams(window.location.search).get("next"));
  useEffect(() => { if (status === "authed") router.replace(back()); }, [status, router]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const u = await run(() => login(email.trim(), password));
    if (u) { commit(email.trim()); router.replace(back()); }
  }

  return (
    <AuthSplit
      logo={<Wordmark height={36} />}
      title="Sign In"
      subtitle="Sign in to your TheChilli.ai Partner account."
      media={authMedia}
      shapeLogo={<PillLogo />}
      headline="Partner"
      tagline={brandCopy.tagline}
    >
      <form onSubmit={submit} noValidate>
        <Input variant="pill" icon={icons.mail} label="Email" type="email" autoComplete="username" inputMode="email" placeholder="Enter your email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <PasswordInput variant="pill" label="Password" autoComplete="current-password" placeholder="Enter your password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <div className="ch-auth__row"><Checkbox label="Remember me" checked={remember} onChange={(e) => setRemember(e.target.checked)} /></div>
        <FormError error={error} />
        <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!email || !password}>Sign in</Button>
      </form>
      {MOCK_MODE && (
        <Card>
          <h2 className="h3">Demo accounts</h2>
          <p className="small muted">Mocked API: no backend needed. Tap one to fill the form.</p>
          <ul className="list">
            {DEMO_LOGINS.map((d) => (
              <li key={d.email}>
                <span className="grow"><span className="title">{d.role.replace("_", " ")}</span><br /><span className="small muted">{d.email}</span></span>
                <Button size="sm" onClick={() => { setEmail(d.email); setPassword(d.password); }}>Use</Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </AuthSplit>
  );
}
