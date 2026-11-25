"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Notice } from "@chilli/ui";
import { api, ApiError, auth } from "@/lib/api";
import { AuthShell } from "@/components/auth/AuthShell";
import { PasswordInput } from "@/components/auth/fields";
import { landingFor, type NavRole } from "@/components/shell/nav-model";
import { readInviteToken } from "@/lib/invite";

/**
 * Target of every "choose your password" link: a new owner after sign-up (platform-core onboarding) and staff added by
 * email. The link is single use; choosing the password signs the person in to THAT restaurant only.
 */
export default function AcceptInvitePage() {
  const router = useRouter();
  const [token, setToken] = useState<string | null | "pending">("pending");
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const t = readInviteToken(window.location.search, window.location.hash);
    try { if (t) window.history.replaceState(null, "", window.location.pathname); } catch { /* ignore */ } // the token leaves the address bar
    void Promise.resolve().then(() => setToken(t));
  }, []);

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    if (!token || token === "pending") return;
    setError(null);
    if (a.length < 10) { setError("Use at least 10 characters."); return; }
    if (a !== b) { setError("The two passwords are not the same."); return; }
    setBusy(true);
    try {
      auth.set(await api.acceptInvite(token, a));
      let role: NavRole = null;
      try { role = (await api.me()).role; } catch { /* counter */ }
      router.replace(landingFor(role));
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) setInvalid(true);
      else if (e instanceof ApiError && e.status === 429) setError("Too many attempts. Wait a while and try again.");
      else if (e instanceof ApiError && e.status === 422) setError(e.message || "Choose a stronger password.");
      else setError("Something went wrong. Please try again.");
    } finally { setBusy(false); }
  }

  const bad = token === null || invalid;
  return (
    <AuthShell>
      <div className="mx-auto w-full max-w-sm">
        <h1 className="font-display text-3xl font-extrabold tracking-tight text-fg">Choose your password</h1>
        {bad ? (
          <div className="mt-6 space-y-4" data-testid="invite-invalid">
            <Notice tone="danger">This link is invalid, was already used or has expired. Ask the restaurant owner to send a new one.</Notice>
            <Link href="/login" className="inline-flex min-h-11 items-center font-semibold text-primary-soft-fg underline-offset-4 hover:underline">Go to sign in</Link>
          </div>
        ) : (
          <>
            <p className="mt-2 text-sm text-fg-muted">This link works once. After this you sign in with your email (or the restaurant code) and this password.</p>
            {error && <div className="mt-6"><Notice tone="danger">{error}</Notice></div>}
            <form noValidate className="mt-6 flex flex-col gap-5" onSubmit={submit} data-testid="accept-invite-form">
              <PasswordInput label="New password" autoComplete="new-password" hint="At least 10 characters." value={a} onChange={(e) => setA(e.target.value)} />
              <PasswordInput label="New password again" autoComplete="new-password" value={b} onChange={(e) => setB(e.target.value)} />
              <Button type="submit" variant="primary" size="lg" loading={busy} disabled={token === "pending"}>Save and sign in</Button>
            </form>
          </>
        )}
      </div>
    </AuthShell>
  );
}
