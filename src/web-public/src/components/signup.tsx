"use client";
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Badge, Button, Card, Input } from "./fields";
import { api, ApiError } from "@/lib/api";
import type { ApplicationCreated, SubmitResult } from "@/lib/api/types";
import { PLANS } from "@/lib/plans";
import { emptySignup, STEP_FIELDS, toApplication, validateSignup, type Errors, type SignupForm } from "@/lib/validate";
import { BUSINESS_TYPE_OPTIONS, type BusinessTypeId } from "@/lib/business-types";
import { formatIndianPhone, normalizeIndianPhone } from "@/lib/phone";
import { formatExpiry, parseInviteParams, toInvitation, type Invitation } from "@/lib/invite";
import { T, useT } from "@/i18n/locale";
import type { CopyKey } from "@/i18n/en";

const KEY_STORE = "chilli-signup-key";
const RESULT_STORE = "chilli-signup-result";
const INVITE_STORE = "chilli-signup-invite"; // the invitation token for this tab only (the URL is cleaned after it is read)
const INVITED_FIELDS: (keyof SignupForm)[] = ["businessName", "ownerName", "phone", "consent"];
type InvitePhase = "none" | "checking" | "valid" | "invalid" | "error" | "gone";
const LAST = STEP_FIELDS.length - 1;
const STEP_TITLES: CopyKey[] = ["signup.s0", "signup.s1", "signup.s2"];
const STATUSES = ["received", "under_review", "approved", "provisioning", "provisioned", "failed", "rejected"];

function ss(op: "get" | "set" | "del", k: string, v?: string): string | null {
  try {
    if (op === "set") sessionStorage.setItem(k, v ?? "");
    else if (op === "del") sessionStorage.removeItem(k);
    else return sessionStorage.getItem(k);
  } catch { /* storage blocked: the wizard still works, just without reload persistence */ }
  return null;
}
const newKey = () => (globalThis.crypto?.randomUUID?.() ?? `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);

type Stored = { receipt?: string; result: SubmitResult | { fake: true } };

export function SignupWizard() {
  const t = useT();
  const [form, setForm] = useState<SignupForm>(emptySignup);
  const [errors, setErrors] = useState<Errors>({});
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [general, setGeneral] = useState<CopyKey | string | null>(null);
  const [done, setDone] = useState<Stored | null>(null);
  const [plan, setPlan] = useState<string | undefined>();
  const [hp, setHp] = useState("");
  const [copied, setCopied] = useState(false);
  const [invite, setInvite] = useState<{ phase: InvitePhase; token?: string; data?: Invitation }>({ phase: "none" });
  const head = useRef<HTMLHeadingElement>(null);
  const summary = useRef<HTMLDivElement>(null);

  /* Reads browser-only state (query string, sessionStorage) after mount so the static HTML stays identical to the server render. */
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get("plan");
    if (p && PLANS.some((x) => x.code === p)) setPlan(p);
    const saved = ss("get", RESULT_STORE);
    if (saved) { try { setDone(JSON.parse(saved) as Stored); return; } catch { ss("del", RESULT_STORE); } }
    const q = parseInviteParams(window.location.search);
    // `?ref=CODE` (a partner's referral code): prefilled into the optional referral field, still checked before submit.
    if (q.ref) setForm((f) => (f.referralCode ? f : { ...f, referralCode: q.ref! }));
    // `?token=` (partner invitation): read once, then removed from the address bar so it is not copied, bookmarked or sent as a referrer.
    if (q.token || q.badToken) {
      const u = new URL(window.location.href);
      u.searchParams.delete("token");
      try { window.history.replaceState(window.history.state, "", u.pathname + u.search + u.hash); } catch { /* ignore */ }
    }
    const token = q.token ?? (q.badToken ? undefined : ss("get", INVITE_STORE) ?? undefined);
    if (q.badToken) setInvite({ phase: "invalid" });
    else if (token) { ss("set", INVITE_STORE, token); void checkInvite(token); }
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  async function checkInvite(token: string) {
    setInvite({ phase: "checking", token });
    try {
      const data = toInvitation(await api.marketing.validateInvitation(token));
      if (!data.valid) { ss("del", INVITE_STORE); setInvite({ phase: "invalid" }); return; }
      // Prefill only what the invitation carries and only into empty fields.
      setForm((f) => ({ ...f, businessName: f.businessName || data.businessName || "", ownerName: f.ownerName || data.contactName || "" }));
      setInvite({ phase: "valid", token, data });
    } catch { setInvite({ phase: "error", token }); }
  }
  function dropInvite() { ss("del", INVITE_STORE); setInvite({ phase: "none" }); setGeneral(null); }

  /** Accepting an invitation: one call that consumes the token and creates the application with the partner's referral attribution. */
  async function redeem(ev: FormEvent) {
    ev.preventDefault();
    const e = validateSignup(form, INVITED_FIELDS);
    setErrors(e);
    if (Object.keys(e).length || !invite.token) return;
    setGeneral(null);
    if (hp) { setDone({ result: { fake: true } }); return; }
    setBusy(true);
    try {
      const res = await api.marketing.redeemInvitation({
        token: invite.token, business_name: form.businessName.trim(), owner_name: form.ownerName.trim(),
        owner_phone: normalizeIndianPhone(form.phone) ?? undefined,
      });
      const stored: Stored = { result: { id: res.application_id, status: "received" } as unknown as ApplicationCreated };
      ss("del", INVITE_STORE);
      ss("set", RESULT_STORE, JSON.stringify(stored));
      setDone(stored);
      setTimeout(() => head.current?.focus(), 0);
    } catch (x) {
      const err = x instanceof ApiError ? x : null;
      if (!err || err.isNetwork) setGeneral("signup.net");
      else if (err.status === 410) { ss("del", INVITE_STORE); setInvite({ phase: "gone" }); }
      else if (err.isRateLimited) setGeneral("signup.rate");
      else if (err.status >= 500) setGeneral("signup.server");
      else setGeneral("signup.bad");
    } finally { setBusy(false); }
  }

  const set = <K extends keyof SignupForm>(k: K, v: SignupForm[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    if (errors[k]) setErrors((e) => ({ ...e, [k]: undefined }));
  };
  const msg = (k?: string) => (k ? t(`err.${k}` as CopyKey) : undefined);
  const hasErrors = Object.values(errors).some(Boolean);

  useEffect(() => { if (hasErrors) summary.current?.focus(); }, [hasErrors, errors]);

  function next() {
    const e = validateSignup(form, STEP_FIELDS[step]);
    setErrors(e);
    if (Object.keys(e).length === 0) { setGeneral(null); setStep(step + 1); setTimeout(() => head.current?.focus(), 0); }
  }
  const firstStepWith = (e: Errors) => Math.max(0, STEP_FIELDS.findIndex((fs) => fs.some((f) => e[f])));
  function toggleType(id: BusinessTypeId, on: boolean) {
    const nextTypes = on ? [...new Set([...form.businessTypes, id])] : form.businessTypes.filter((b) => b !== id);
    set("businessTypes", nextTypes);
  }

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    if (step < LAST) return next();
    const e = validateSignup(form);
    setErrors(e);
    if (Object.keys(e).length) {
      const s0 = firstStepWith(e);
      if (s0 < LAST) setStep(s0);
      return;
    }
    setGeneral(null);
    if (hp) { // honeypot tripped: pretend success, send nothing
      setDone({ result: { fake: true } });
      return;
    }
    setBusy(true);
    try {
      const code = form.referralCode.trim().toUpperCase();
      if (code) {
        try { await api.marketing.checkReferralCode(code); }
        catch (x) {
          if (x instanceof ApiError && (x.status === 404 || x.status === 422)) { setErrors({ referralCode: "referral_unknown" }); setBusy(false); return; }
          /* any other failure: the code is optional and the server re-checks, carry on */
        }
      }
      let key = ss("get", KEY_STORE);
      if (!key) { key = newKey(); ss("set", KEY_STORE, key); }
      const res = await api.onboarding.submit(toApplication({ ...form, referralCode: code }, key, plan));
      const stored: Stored = { receipt: "idempotency_receipt" in res ? res.idempotency_receipt : undefined, result: res };
      ss("set", RESULT_STORE, JSON.stringify(stored));
      setDone(stored);
      setTimeout(() => head.current?.focus(), 0);
    } catch (x) {
      const err = x instanceof ApiError ? x : null;
      if (!err || err.isNetwork) setGeneral("signup.net");
      else if (err.isRateLimited) setGeneral("signup.rate");
      else if (err.status >= 500) setGeneral("signup.server");
      else if (err.fieldErrors.length) {
        const map: Record<string, keyof SignupForm> = { business_types: "businessTypes", business_name: "businessName", contact_name: "ownerName", email: "email", phone: "phone", gstin: "gstin", city: "city" };
        const fe: Errors = {};
        for (const f of err.fieldErrors) { const k = map[f.field]; if (k) fe[k] = k === "email" ? "email" : k === "phone" ? "phone" : k === "gstin" ? "gstin_format" : k === "businessTypes" ? "types" : "required"; }
        setErrors(fe);
        if (Object.keys(fe).length === 0) setGeneral("signup.bad");
        else setStep(firstStepWith(fe));
      } else setGeneral("signup.bad");
    } finally { setBusy(false); }
  }

  function reset() {
    ss("del", KEY_STORE); ss("del", RESULT_STORE); ss("del", INVITE_STORE);
    setInvite({ phase: "none" });
    setDone(null); setForm(emptySignup); setErrors({}); setStep(0); setGeneral(null);
  }

  if (done) {
    const r = done.result as Partial<ApplicationCreated> & { fake?: boolean; accepted?: boolean };
    const status = r.status ?? "received";
    const statusLabel = STATUSES.includes(status) ? t(`signup.status.${status}` as CopyKey) : status;
    return (
      <Card as="section" className="done" aria-labelledby="done-h">
        <h2 id="done-h" ref={head} tabIndex={-1}><T k="signup.done.t" /></h2>
        <div role="status">
          {r.id || r.fake ? <p><T k="signup.done.d" params={{ status: statusLabel }} /></p> : <p><T k="signup.done.dup" /></p>}
        </div>
        {r.id ? <dl className="kv"><dt><T k="signup.done.id" /></dt><dd className="mono" data-testid="app-id">{r.id}</dd><dt><T k="signup.done.status" /></dt><dd><Badge tone="info">{statusLabel}</Badge></dd></dl> : null}
        {done.receipt ? (
          <div className="receipt">
            <h3><T k="signup.done.receipt" /></h3>
            <p className="token" data-testid="receipt" translate="no">{done.receipt}</p>
            <p className="small muted"><T k="signup.done.receipt.d" /></p>
            <Button onClick={async () => { try { await navigator.clipboard.writeText(done.receipt!); setCopied(true); } catch { /* clipboard unavailable */ } }}>
              {copied ? t("signup.done.copied") : t("signup.done.copy")}
            </Button>
          </div>
        ) : null}
        <p><Button variant="ghost" onClick={reset}><T k="signup.done.new" /></Button></p>
      </Card>
    );
  }

  const { phase, data: inv } = invite;
  if (phase === "checking") return <div className="wizard"><div className="notice info" role="status"><T k="signup.inv.checking" /></div></div>;
  if (phase === "error") {
    return (
      <div className="wizard">
        <div className="notice danger" role="alert"><T k="signup.inv.net" /></div>
        <div className="row">
          <Button variant="primary" onClick={() => void checkInvite(invite.token!)}><T k="signup.inv.retry" /></Button>
          <Button variant="ghost" onClick={dropInvite}><T k="signup.inv.skip" /></Button>
        </div>
      </div>
    );
  }
  if (phase === "gone") {
    return (
      <div className="wizard">
        <div className="notice danger" role="alert"><T k="signup.inv.gone" /></div>
        <p><Button variant="ghost" onClick={dropInvite}><T k="signup.inv.skip" /></Button></p>
      </div>
    );
  }
  if (phase === "valid") {
    const keys = Object.keys(errors).filter((k) => errors[k as keyof SignupForm]) as (keyof SignupForm)[];
    return (
      <form className="wizard" onSubmit={redeem} noValidate aria-labelledby="wiz-h" data-testid="invited-form">
        <h2 id="wiz-h" ref={head} tabIndex={-1}><T k="signup.inv.h" /></h2>
        <div className="notice info" role="status">
          {inv?.invitedBy ? <p className="inv-by"><strong data-testid="invited-by"><T k="signup.inv.by" params={{ name: inv.invitedBy }} /></strong></p> : null}
          <p><T k="signup.inv.ok" />{inv?.expiresAt ? <> <T k="signup.inv.exp" params={{ when: formatExpiry(inv.expiresAt) }} /></> : null}</p>
        </div>
        {keys.length > 0 ? (
          <div className="notice danger" role="alert" tabIndex={-1} ref={summary}>
            <strong><T k="signup.errors.title" /></strong>
            <ul>{keys.map((k) => <li key={k}><a href={`#f-${k}`}>{msg(errors[k])}</a></li>)}</ul>
          </div>
        ) : null}
        {general ? <div className="notice danger" role="alert">{t(general as CopyKey)}</div> : null}
        <div className="fields">
          <Input id="f-businessName" name="businessName" label={t("signup.businessName")} value={form.businessName} onChange={(e) => set("businessName", e.target.value)} error={msg(errors.businessName)} autoComplete="organization" maxLength={160} required />
          <Input id="f-ownerName" name="ownerName" label={t("signup.ownerName")} value={form.ownerName} onChange={(e) => set("ownerName", e.target.value)} error={msg(errors.ownerName)} autoComplete="name" maxLength={120} required />
          <Input id="f-phone" name="phone" type="tel" label={t("signup.phone")} hint={form.phone && normalizeIndianPhone(form.phone) ? formatIndianPhone(normalizeIndianPhone(form.phone)!) : t("signup.phone.hint")} value={form.phone} onChange={(e) => set("phone", e.target.value)} error={msg(errors.phone)} autoComplete="tel" inputMode="tel" required />
          <p className="small muted"><T k="signup.inv.email" /></p>
          <div className="hp" aria-hidden="true">
            <label>{t("demo.hp")}<input type="text" name="website" tabIndex={-1} autoComplete="off" value={hp} onChange={(e) => setHp(e.target.value)} /></label>
          </div>
          <div className="check-field">
            <label className="checkbox">
              <input id="f-consent" type="checkbox" checked={form.consent} onChange={(e) => set("consent", e.target.checked)} aria-invalid={errors.consent ? true : undefined} aria-describedby={errors.consent ? "f-consent-err" : undefined} />
              <span>{t("signup.consent")} (<Link href="/terms" target="_blank">{t("signup.terms")}</Link>, <Link href="/privacy" target="_blank">{t("signup.privacy")}</Link>)</span>
            </label>
            {errors.consent ? <p className="ch-error" id="f-consent-err">{msg(errors.consent)}</p> : null}
          </div>
          <p className="small muted"><T k="signup.inv.later" /></p>
        </div>
        <div className="row"><Button type="submit" variant="primary" size="lg" loading={busy}>{t(busy ? "signup.submitting" : "signup.submit")}</Button></div>
      </form>
    );
  }

  const keys = Object.keys(errors).filter((k) => errors[k as keyof SignupForm]) as (keyof SignupForm)[];
  return (
    <form className="wizard" onSubmit={submit} noValidate aria-labelledby="wiz-h">
      <p className="small muted" aria-live="polite"><T k="signup.step" params={{ n: step + 1, total: LAST + 1 }} /></p>
      <ol className="steps" aria-hidden="true">{STEP_FIELDS.map((_, i) => <li key={i} className={i === step ? "cur" : i < step ? "done" : ""} />)}</ol>
      <h2 id="wiz-h" ref={head} tabIndex={-1}>{t(STEP_TITLES[step]!)}</h2>
      {phase === "invalid" ? <div className="notice" role="status" data-testid="invite-invalid"><T k="signup.inv.bad" /></div> : null}
      {plan ? <p className="small"><T k="signup.plan" />: <Badge tone="primary">{PLANS.find((p) => p.code === plan)?.name}</Badge></p> : null}

      {keys.length > 0 ? (
        <div className="notice danger" role="alert" tabIndex={-1} ref={summary}>
          <strong><T k="signup.errors.title" /></strong>
          <ul>{keys.map((k) => <li key={k}><a href={`#f-${k}`}>{msg(errors[k])}</a></li>)}</ul>
        </div>
      ) : null}
      {general ? <div className="notice danger" role="alert">{t(general as CopyKey)}</div> : null}

      <div className="fields" hidden={step !== 0}>
        <fieldset className="types" id="f-businessTypes" aria-describedby={errors.businessTypes ? "f-businessTypes-err" : "f-businessTypes-lead"} aria-invalid={errors.businessTypes ? true : undefined}>
          <legend className="ch-sr-only">{t("signup.s0")}</legend>
          <p className="small muted" id="f-businessTypes-lead">{t("signup.types.lead")}</p>
          {BUSINESS_TYPE_OPTIONS.map((o) => (
            <label key={o.id} className="type-card">
              <input type="checkbox" name="business_types" value={o.id} checked={form.businessTypes.includes(o.id)} onChange={(e) => toggleType(o.id, e.target.checked)} />
              <span><strong>{o.label}</strong><span className="small muted">{o.description}</span>{o.hint ? <span className="small">{o.hint}</span> : null}</span>
            </label>
          ))}
          {errors.businessTypes ? <p className="ch-error" id="f-businessTypes-err" role="alert">{msg(errors.businessTypes)}</p> : null}
        </fieldset>
      </div>

      <div className="fields" hidden={step !== 1}>
        <Input id="f-businessName" name="businessName" label={t("signup.businessName")} value={form.businessName} onChange={(e) => set("businessName", e.target.value)} error={msg(errors.businessName)} autoComplete="organization" maxLength={200} required />
        <Input id="f-outlets" name="outlets" label={t("signup.outlets")} hint={t("signup.outlets.hint")} inputMode="numeric" value={form.outlets} onChange={(e) => set("outlets", e.target.value)} error={msg(errors.outlets)} required />
        <Input id="f-city" name="city" label={t("signup.city")} value={form.city} onChange={(e) => set("city", e.target.value)} error={msg(errors.city)} autoComplete="address-level2" maxLength={100} required />
        <Input id="f-gstin" name="gstin" label={t("signup.gstin")} hint={t("signup.gstin.hint")} value={form.gstin} onChange={(e) => set("gstin", e.target.value.toUpperCase())} error={msg(errors.gstin)} maxLength={20} autoCapitalize="characters" spellCheck={false} className="mono" />
      </div>

      <div className="fields" hidden={step !== 2}>
        <Input id="f-ownerName" name="ownerName" label={t("signup.ownerName")} value={form.ownerName} onChange={(e) => set("ownerName", e.target.value)} error={msg(errors.ownerName)} autoComplete="name" maxLength={200} required />
        <Input id="f-phone" name="phone" type="tel" label={t("signup.phone")} hint={form.phone && normalizeIndianPhone(form.phone) ? formatIndianPhone(normalizeIndianPhone(form.phone)!) : t("signup.phone.hint")} value={form.phone} onChange={(e) => set("phone", e.target.value)} error={msg(errors.phone)} autoComplete="tel" inputMode="tel" required />
        <Input id="f-email" name="email" type="email" label={t("signup.email")} value={form.email} onChange={(e) => set("email", e.target.value)} error={msg(errors.email)} autoComplete="email" maxLength={254} required />
        <Input id="f-referralCode" name="referralCode" label={t("signup.referral")} hint={t("signup.referral.hint")} value={form.referralCode} onChange={(e) => set("referralCode", e.target.value)} error={msg(errors.referralCode)} maxLength={32} autoCapitalize="characters" spellCheck={false} />
        <div className="hp" aria-hidden="true">
          <label>{t("demo.hp")}<input type="text" name="website" tabIndex={-1} autoComplete="off" value={hp} onChange={(e) => setHp(e.target.value)} /></label>
        </div>
        <div className="check-field">
          <label className="checkbox">
            <input id="f-consent" type="checkbox" checked={form.consent} onChange={(e) => set("consent", e.target.checked)} aria-invalid={errors.consent ? true : undefined} aria-describedby={errors.consent ? "f-consent-err" : undefined} />
            <span>{t("signup.consent")} (<Link href="/terms" target="_blank">{t("signup.terms")}</Link>, <Link href="/privacy" target="_blank">{t("signup.privacy")}</Link>)</span>
          </label>
          {errors.consent ? <p className="ch-error" id="f-consent-err">{msg(errors.consent)}</p> : null}
        </div>
        <p className="small muted"><T k="signup.retry.note" /></p>
      </div>

      <div className="row">
        {step > 0 ? <Button onClick={() => { setStep(step - 1); setErrors({}); }}><T k="signup.back" /></Button> : null}
        {step < LAST ? <Button type="submit" variant="primary" size="lg"><T k="signup.next" /></Button>
          : <Button type="submit" variant="primary" size="lg" loading={busy}>{t(busy ? "signup.submitting" : "signup.submit")}</Button>}
      </div>
    </form>
  );
}
