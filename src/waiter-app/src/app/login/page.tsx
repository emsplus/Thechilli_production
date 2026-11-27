"use client";
import Link from "next/link";
import { ADMIN_URL, openAdmin, setMode } from "@/lib/adminUrl";
import { useRouter } from "next/navigation";
import { LeafArt, Wave } from "@/components/Scenery";
import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, auth } from "@/lib/api";
import { homeRouteNow } from "@/lib/capsStore";
import { engine } from "@/lib/sync";
import { defaultSessionGateway } from "@/lib/session";
import { markSessionStart } from "@/lib/sessionStart";
import { useT } from "@/lib/i18n";
import { expiredMessage } from "@/lib/sessionExpired";
import { lockState, prefs } from "@/lib/lock/state";
import { isNative } from "@/lib/native/platform";
import { rememberRestaurantCode, savedRestaurantCode } from "@/lib/restaurantCode";

export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [restaurant, setRestaurant] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [forgot, setForgot] = useState(false);
  const t = useT();
  const [expired, setExpired] = useState<string | null>(null);
  const [wiped, setWiped] = useState(false);
  const [native, setNative] = useState(false);
  // "Back to staff login" from the admin site lands here with ?mode=staff: this phone is a staff phone again.
  useEffect(() => { if (new URLSearchParams(window.location.search).get("mode") === "staff") setMode("staff"); }, []);
  useEffect(() => {
    let live = true;
    // Tokens are loaded from secure storage on native; wait for that before deciding the session is gone.
    void auth.hydrate().then(() => { if (live) { setWiped(prefs.wiped()); setNative(isNative()); setRestaurant((r) => r || savedRestaurantCode()); /* remembered from the last successful sign-in on this device */ } }).then(() => (auth.expired ? engine.list() : null)).then((ops) => {
      if (live && ops) setExpired(expiredMessage(ops.filter((o) => o.status !== "synced").map((o) => o.order_ref)));
    }).catch(() => { if (live && auth.expired) setExpired(expiredMessage([])); });
    return () => { live = false; };
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      auth.set(await api.login(email.trim(), password, restaurant.trim() || undefined));
      markSessionStart();
      const me = await api.me();
      if (!["owner", "manager", "waiter", "cashier"].includes(me.role)) { auth.clear(); throw new ApiError(403, "This account cannot take orders"); }
      rememberRestaurantCode(restaurant, me.restaurant_code);
      setMode("staff"); // this phone is used as the waiter app until "Admin login" is chosen
      prefs.setWiped(false);
      // Phone app: offer an MPIN right after the password sign-in (never on this screen). Skippable once (lib/lock/state.ts).
      if (isNative() && lockState.get().available && !lockState.get().enabled) { router.replace("/mpin"); return; }
      router.replace(defaultSessionGateway.currentShift() ? homeRouteNow() : "/outlet"); // same waiter, same device: the shift is still theirs
    } catch (x) {
      setErr(x instanceof ApiError && x.status === 0 ? "Cannot reach the server. Check Wi-Fi and try again." : x instanceof Error ? x.message : "Sign-in failed");
    } finally { setBusy(false); }
  }

  return (
    <div className="entry">
      <header className="art"><LeafArt compact /><Wave /></header>
      <main id="main" className="body grow">
        <h1>{t("login.title")}</h1>
        <p className="sub">{t("welcome.sub")}</p>
        <span className="accent" aria-hidden="true" />
        <form onSubmit={submit} noValidate>
          <label className="uf"><span>{t("login.email")}</span><input type="text" autoComplete="username" inputMode="text" autoCapitalize="none" autoCorrect="off" spellCheck={false} required placeholder={t("login.emailPlaceholder")} value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <div className="uf"><label className="lbl" htmlFor="pw">{t("login.password")}</label>
            <div className="pwrow">
              <input id="pw" type={showPw ? "text" : "password"} autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
              <button type="button" className="eye" aria-pressed={showPw} onClick={() => setShowPw((v) => !v)}>
                <span className="sr-only">{showPw ? t("login.hide") : t("login.show")}</span>
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z" /><circle cx="12" cy="12" r="3" />{showPw && <path d="M4 4l16 16" />}</svg>
              </button>
            </div>
          </div>
          <div className="uf"><label className="lbl" htmlFor="rc">{t("login.restaurant")}</label>
            <input id="rc" value={restaurant} onChange={(e) => setRestaurant(e.target.value)} autoCapitalize="characters" autoCorrect="off" spellCheck={false} autoComplete="off" maxLength={36} aria-describedby="rc-help" />
            <p className="hint" id="rc-help">{t("login.restaurantHelp")}</p>
          </div>
          <div className="entry-links">
            <button type="button" className="forgot" aria-expanded={forgot} onClick={() => setForgot((v) => !v)}>{t("login.forgot")}</button>
          </div>
          {forgot && <div className="banner" role="status">{t("login.forgotInfo")}</div>}
          {wiped && !err && <div className="banner err" role="alert">Too many wrong MPIN tries. For your safety this phone was signed out. Sign in with your email and password, then set a new MPIN.</div>}
          {expired && !err && !wiped && <div className="banner" role="status">{expired}</div>}
          {err && <div className="banner err" role="alert">{err}</div>}
          <div className="spacer" />
          <p className="hint">{t("login.helper")} {t("login.help")}</p>
          {ADMIN_URL && <button type="button" className="btn outline block pillbtn" data-testid="admin-login" onClick={() => openAdmin()}>Admin login (owner / manager)</button>}
          {native && <Link className="forgot center" href="/counter">Set up as a shared counter tablet</Link>}
          <div className="actions">
            <Link className="btn outline pillbtn" href="/signup">{t("login.signUp")}</Link>
            <button className="btn primary grad pillbtn" disabled={busy || !email || !password}>{busy ? t("login.submitting") : t("login.submit")}</button>
          </div>
        </form>
      </main>
    </div>
  );
}
