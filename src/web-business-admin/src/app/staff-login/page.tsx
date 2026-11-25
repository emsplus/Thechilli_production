"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Input, Notice } from "@chilli/ui";
import { api, ApiError, auth } from "@/lib/api";
import { AuthPage } from "@/components/auth/AuthShell";
import { PasswordInput } from "@/components/auth/fields";
import { landingFor, type NavRole } from "@/components/shell/nav-model";

const CODE_KEY = "pos.restaurantCode"; // remembered on this device (not a secret: it only picks the restaurant)

function friendly(e: unknown): string {
  if (!(e instanceof ApiError)) return "Something went wrong. Please try again.";
  if (e.status === 0) return "Cannot reach the server. Check your internet connection and try again.";
  if (e.status === 401) return "The restaurant code, phone / username or password is wrong.";
  if (e.status === 429) return "Too many attempts. Wait a few minutes and try again.";
  if (e.status === 422) return e.message || "Check the restaurant code and your phone number or username.";
  return e.status >= 500 ? "The server has a problem. Try again in a moment." : e.message;
}

/**
 * Staff sign-in (pos-service docs/STAFF_WIRING_CHECK.md): restaurant code + phone / username / email + password. The code
 * picks the restaurant, so a waiter never lands in another one. A one-time password from the owner must be replaced first.
 */
export default function StaffLoginPage() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [id, setId] = useState("");
  const [pw, setPw] = useState("");
  const [next, setNext] = useState({ a: "", b: "" });
  const [mustChange, setMustChange] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { try { const c = localStorage.getItem(CODE_KEY); if (c) void Promise.resolve().then(() => setCode(c)); } catch { /* ignore */ } }, []);

  async function land() {
    let role: NavRole = null;
    try { role = (await api.me()).role; } catch { /* counter */ }
    router.replace(landingFor(role));
  }

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    setError(null);
    const c = code.trim().toUpperCase();
    if (!c || !id.trim() || !pw) { setError("Enter the restaurant code, your phone number or username, and your password."); return; }
    setBusy(true);
    try {
      const r = await api.loginWithCode(c, id.trim(), pw);
      auth.set(r);
      try { localStorage.setItem(CODE_KEY, c); } catch { /* ignore */ }
      if (r.password_change_required) { setMustChange(true); return; }
      await land();
    } catch (e) { setError(friendly(e)); } finally { setBusy(false); }
  }

  async function change(ev: FormEvent) {
    ev.preventDefault();
    setError(null);
    if (next.a.length < 10) { setError("Use at least 10 characters."); return; }
    if (next.a !== next.b) { setError("The two passwords are not the same."); return; }
    setBusy(true);
    try {
      await api.changePassword(pw, next.a);
      auth.set(await api.loginWithCode(code.trim().toUpperCase(), id.trim(), next.a)); // fresh session with the new password
      await land();
    } catch (e) { setError(friendly(e)); } finally { setBusy(false); }
  }

  if (mustChange) {
    return (
      <AuthPage title="Choose your password" subtitle="You signed in with a one-time password. Choose your own to continue.">
        {error && <Notice tone="danger">{error}</Notice>}
        <form noValidate method="post" onSubmit={change} data-testid="staff-change-password">
          <PasswordInput variant="pill" label="New password" autoComplete="new-password" hint="At least 10 characters." value={next.a} onChange={(e) => setNext({ ...next, a: e.target.value })} />
          <PasswordInput variant="pill" label="New password again" autoComplete="new-password" value={next.b} onChange={(e) => setNext({ ...next, b: e.target.value })} />
          <Button type="submit" variant="primary" size="lg" loading={busy}>Save and continue</Button>
        </form>
      </AuthPage>
    );
  }

  return (
    <AuthPage title="Staff sign-in" subtitle="Use your restaurant's code with your phone number or username. Ask your manager for the code.">
      {error && <Notice tone="danger">{error}</Notice>}
      <form noValidate method="post" onSubmit={submit} data-testid="staff-login-form">
        <Input variant="pill" label="Restaurant code" autoComplete="organization" autoCapitalize="characters" spellCheck={false} maxLength={8} placeholder="e.g. K7M3QX" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
        <Input variant="pill" label="Phone, username or email" autoComplete="username" spellCheck={false} value={id} onChange={(e) => setId(e.target.value)} />
        <PasswordInput variant="pill" label="Password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
        <Button type="submit" variant="primary" size="lg" loading={busy}>Sign in</Button>
        <div className="ch-auth__center"><Link href="/login" className="text-sm font-semibold text-primary-soft-fg underline-offset-4 hover:underline">Owner or manager? Sign in with email</Link></div>
      </form>
    </AuthPage>
  );
}
