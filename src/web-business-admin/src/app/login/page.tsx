"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { takeReturnTo } from "@/lib/returnTo";
import { appOrigin, rememberAppOrigin, staffLoginHref } from "@/lib/appOrigin";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { api, ApiError, auth } from "@/lib/api";
import { AuthPage } from "@/components/auth/AuthShell";
import { PasswordInput } from "@/components/auth/fields";
import { ForgotPasswordDialog } from "@/components/auth/ForgotPasswordDialog";
import { Button, Checkbox, Input, Notice, RadioGroup, icons } from "@chilli/ui";
import { useRememberedEmail } from "@chilli/ui/auth";
import { useMsg } from "@/lib/i18n";
import { AUTH_MSG } from "@/components/auth/messages";
import { fieldError } from "@/components/auth/validation";
import { landingFor, type NavRole } from "@/components/shell/nav-model";

const schema = z.object({ email: z.string().trim().email("Enter a valid email"), password: z.string().min(1, "Password required") });
type Login = z.infer<typeof schema>;

function friendly(e: unknown, t: (key: string) => string): string {
  if (!(e instanceof ApiError)) return t("genericError");
  if (e.status === 0) return t("offline");
  if (e.status === 401) return t("badCreds");
  if (e.status === 409) return t("multipleNoList"); // an older server: "several restaurants", without the list
  if (e.status === 429) return t("tooManyAttempts");
  if (e.status >= 500) return t("serverProblem");
  return e.message;
}

interface Choice { id: string; name: string }

/**
 * The restaurants of a 409 multiple_restaurants answer. The API sends it only after the password matched, so showing the
 * names leaks nothing the person does not already have access to. Anything malformed = no list.
 */
function restaurantsOf(e: unknown): Choice[] | null {
  if (!(e instanceof ApiError) || e.status !== 409 || e.code !== "multiple_restaurants") return null;
  const list = e.details?.restaurants;
  if (!Array.isArray(list)) return null;
  const out = list.filter((r): r is Choice => !!r && typeof r.id === "string" && typeof r.name === "string").slice(0, 50);
  return out.length > 1 ? out : null;
}

export default function LoginPage() {
  const t = useMsg(AUTH_MSG);
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [forgot, setForgot] = useState(false);
  // Second step when the email belongs to several restaurants: the credentials are kept in memory only until it ends.
  const [pick, setPick] = useState<{ email: string; password: string; restaurants: Choice[] } | null>(null);
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const [pickError, setPickError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const { register, handleSubmit, setValue, getValues, formState: { errors, isSubmitting } } = useForm<Login>({ resolver: zodResolver(schema) });
  // Remember me keeps only the email on this device (never the password or a token).
  const remembered = useRememberedEmail("pos.rememberEmail");
  useEffect(() => { if (remembered.email && !getValues("email")) setValue("email", remembered.email); }, [remembered.email, getValues, setValue]);

  // Already signed in (readable session marker) but the server rendered this page because the first request carried no cookies
  // (SameSite=Strict: the Chilli Staff app opens this site from another origin). The marker is checked from inside the page,
  // where the cookies do travel; a still-valid session goes straight home, an expired one stays here.
  const [staffApp, setStaffApp] = useState<string | null>(null);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { rememberAppOrigin(window.location.search); setStaffApp(appOrigin()); }, []);
  useEffect(() => {
    if (!auth.token) return;
    let live = true;
    void api.me().then((me) => { if (live) router.replace(takeReturnTo() ?? landingFor(me.role)); }).catch(() => { /* expired or offline: show the form */ });
    return () => { live = false; };
  }, [router]);

  async function signedIn(email: string) {
    remembered.commit(email.trim());
    // Role-based home (owner/manager Today, cashier/waiter Counter, kitchen Kitchen). If the role cannot be read, fall back to the counter.
    let role: NavRole = null;
    try { role = (await api.me()).role; } catch { /* offline or slow: counter */ }
    router.replace(takeReturnTo() ?? landingFor(role)); // back to the counter when its "Session expired" prompt sent the cashier here
  }

  async function submit(d: Login) {
    setError(null);
    try { auth.set(await api.login(d.email, d.password)); }
    catch (e) {
      const restaurants = restaurantsOf(e);
      if (restaurants) { setChosen(undefined); setPickError(null); setPick({ email: d.email, password: d.password, restaurants }); return; }
      setError(friendly(e, t)); return;
    }
    await signedIn(d.email);
  }

  async function submitPick(ev: FormEvent) {
    ev.preventDefault();
    if (!pick) return;
    if (!chosen) { setPickError(t("pickRequired")); return; }
    setPickError(null); setPicking(true);
    try { auth.set(await api.login(pick.email, pick.password, chosen)); }
    catch (e) {
      setPicking(false);
      // A changed password or a removed account while choosing: back to the first step with the usual message.
      if (e instanceof ApiError && e.status === 401) { setPick(null); setValue("password", ""); setError(t("badCreds")); return; }
      setPickError(friendly(e, t)); return;
    }
    const email = pick.email;
    setPick(null);
    await signedIn(email);
  }

  const back = () => { setPick(null); setPickError(null); setValue("password", ""); };

  if (pick) {
    return (
      <AuthPage title={t("pickTitle")} subtitle={t("pickDesc")}>
        {pickError && <Notice tone="danger">{pickError}</Notice>}
        <form noValidate method="post" onSubmit={submitPick}>
          <RadioGroup legend={t("pickLegend")} name="restaurant" value={chosen} onValueChange={setChosen}
            options={pick.restaurants.map((r) => ({ value: r.id, label: r.name }))} />
          <Button type="submit" variant="primary" size="lg" loading={picking}>{t("pickContinue")}</Button>
          <div className="ch-auth__center">
            <Button variant="ghost" size="sm" onClick={back}>{t("pickBack")}</Button>
          </div>
        </form>
      </AuthPage>
    );
  }

  return (
    <AuthPage
      title={t("loginTitle")}
      subtitle={t("loginDesc")}
    >
      {error && <Notice tone="danger">{error}</Notice>}
      <form noValidate method="post" onSubmit={handleSubmit(submit)}>
        <Input variant="pill" icon={icons.mail} label={t("email")} type="email" inputMode="email" autoComplete="username" placeholder="you@example.com" error={fieldError(t, errors.email?.message)} {...register("email")} />
        <PasswordInput variant="pill" label={t("password")} autoComplete="current-password" placeholder={t("passwordPlaceholder")} error={fieldError(t, errors.password?.message)} {...register("password")} />
        <div className="ch-auth__row">
          <Checkbox label={t("rememberMe")} checked={remembered.remember} onChange={(e) => remembered.setRemember(e.target.checked)} />
        </div>
        <div className="ch-auth__center">
          <Button variant="ghost" size="sm" onClick={() => setForgot(true)}>{t("forgotLink")}</Button>
        </div>
        <Button type="submit" variant="primary" size="lg" loading={isSubmitting}>{t("logIn")}</Button>
        <div className="ch-auth__center"><Link href="/staff-login" className="inline-flex min-h-11 items-center text-sm font-semibold text-primary-soft-fg underline-offset-4 hover:underline">Staff without email? Sign in with the restaurant code</Link></div>
        {staffApp && <div className="ch-auth__center"><a href={staffLoginHref(staffApp)} data-testid="back-to-staff" className="inline-flex min-h-11 items-center text-sm font-semibold text-primary-soft-fg underline-offset-4 hover:underline">Back to staff login (waiter app)</a></div>}
      </form>
      <ForgotPasswordDialog open={forgot} onOpenChange={setForgot} />
    </AuthPage>
  );
}
