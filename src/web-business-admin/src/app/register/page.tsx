"use client";

import { Button, Checkbox, Input, Notice, icons } from "@chilli/ui";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { api, ApiError, auth, isSignupPending, type SessionGrant } from "@/lib/api";
import { AuthPage } from "@/components/auth/AuthShell";
import { PasswordInput } from "@/components/auth/fields";
import { SignupCodeStep, type CodeClock } from "@/components/auth/SignupCodeStep";
import { clockNow, DEFAULT_RESEND_SECONDS } from "@/lib/signupCode";
import { SIGNUP_COUNTRY } from "@/lib/countries";
import { gstinError, gstinState, normaliseGstin } from "@/lib/gstin";
import { landingFor } from "@/components/shell/nav-model";
import { ONBOARDING_API, submitApplication } from "@/lib/invite";
import { BUSINESS_TYPE_FALLBACK, BUSINESS_TYPE_IDS, canonicalTypes, typeHint, type BusinessType } from "@/lib/business";
import { businessTypes } from "@/lib/deliveryApi";

// India only: the restaurant is created in IN (INR, Asia/Kolkata, GST). The GSTIN is optional and can be added later in Manage.
// Production: the ONE sign-up workflow is platform-core onboarding (NEXT_PUBLIC_ONBOARDING_API_URL): no password here, the
// owner chooses it from the emailed link (/accept-invite), which also proves the email. Unset (local / e2e): the direct
// pos-service sign-up, which pos-service only allows in development (SELF_REGISTER_ENABLED).
const VIA_ONBOARDING = !!ONBOARDING_API;
const TYPES_LEGEND = "What do you run? (choose one or more)";
const schema = z.object({
  // docs/BUSINESS_TYPES.md: one or more, Restaurant pre-selected, at least one stays selected.
  business_types: z.array(z.enum(BUSINESS_TYPE_IDS as [BusinessType, ...BusinessType[]])).min(1, "Choose at least one"),
  owner_name: z.string().trim().min(1, "Enter your name"),
  restaurant_name: z.string().trim().min(1, "Enter the restaurant name"),
  owner_email: z.string().trim().email("Enter a valid email"),
  owner_password: VIA_ONBOARDING ? z.string() : z.string().min(10, "At least 10 characters"),
  gstin: z.string(),
}).superRefine((d, ctx) => {
  const m = gstinError(d.gstin);
  if (m) ctx.addIssue({ code: "custom", path: ["gstin"], message: m });
});
type Reg = z.infer<typeof schema>;

/** Error codes a server may use for "this email already has an account" (shown exactly like a confirmation-pending sign-up). */
const EMAIL_TAKEN = new Set(["email_in_use", "email_taken", "email_exists"]);

function gstinHint(value: string): string {
  const v = normaliseGstin(value);
  const state = v.length >= 2 ? gstinState(v) : null;
  if (state) return `State: ${state}`;
  return "15 characters from your GST registration, e.g. 27AAPFU0939F1ZV. You can add it later in Manage.";
}

/** A sign-up waiting for its emailed code (202 from register-restaurant). Kept for the tab so a reload keeps the code step. */
interface Pending extends CodeClock { email: string; expiresIn: number }
const PENDING_KEY = "pos.signupPending";
const loadPending = (): Pending | null => {
  try {
    const p = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? "null") as Pending | null;
    return p && typeof p.email === "string" && Date.now() < p.expiresAt + 60 * 60_000 ? p : null; // a stale entry: start over
  } catch { return null; }
};
const savePending = (p: Pending | null) => {
  try { if (p) sessionStorage.setItem(PENDING_KEY, JSON.stringify(p)); else sessionStorage.removeItem(PENDING_KEY); } catch { /* storage blocked: no reload persistence */ }
};

export default function RegisterPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null); // direct pos-service sign-up answered 202 (or the email is taken)
  const [appliedTo, setAppliedTo] = useState<string | null>(null); // platform-core onboarding application accepted
  const [pending, setPendingState] = useState<Pending | null>(null);
  const setPending = (p: Pending | null) => { setPendingState(p); savePending(p); };
  // eslint-disable-next-line react-hooks/set-state-in-effect -- sessionStorage is browser-only: read after mount so the server render matches
  useEffect(() => { setPendingState(loadPending()); }, []);
  const { register, handleSubmit, control, setValue, formState: { errors, isSubmitting, isSubmitted } } = useForm<Reg>({ resolver: zodResolver(schema), defaultValues: { gstin: "", business_types: ["restaurant"] } });
  const gstin = useWatch({ control, name: "gstin" }) ?? "";
  const picked = useWatch({ control, name: "business_types" }) ?? [];
  // The type cards come from GET /business-types (public); the same three ids are shown when it cannot be loaded.
  const [catalogue, setCatalogue] = useState<readonly { id: BusinessType; label: string; description: string }[]>(BUSINESS_TYPE_FALLBACK);
  useEffect(() => {
    let off = false;
    businessTypes.catalogue().then((c) => {
      const known = Array.isArray(c) ? c.filter((x) => (BUSINESS_TYPE_IDS as readonly string[]).includes(x.id) && x.label) : [];
      if (!off && known.length) setCatalogue(known);
    }).catch(() => { /* keep the built-in list */ });
    return () => { off = true; };
  }, []);
  const toggleType = (id: BusinessType, on: boolean) =>
    setValue("business_types", canonicalTypes(on ? [...picked, id] : picked.filter((x) => x !== id)), { shouldValidate: isSubmitted, shouldDirty: true });

  async function submit(d: Reg) {
    setError(null);
    const trn = normaliseGstin(d.gstin);
    if (VIA_ONBOARDING) {
      let key = "";
      try { key = sessionStorage.getItem("pos.signupKey") || crypto.randomUUID(); sessionStorage.setItem("pos.signupKey", key); } catch { key = crypto.randomUUID(); }
      try {
        await submitApplication({ business_name: d.restaurant_name.trim(), contact_name: d.owner_name.trim(), email: d.owner_email.trim(),
          gstin: trn || undefined, business_types: canonicalTypes(d.business_types), idempotency_key: key });
        setAppliedTo(d.owner_email.trim());
      } catch (e) { setError(e instanceof Error ? e.message : "Sign-up failed. Please try again."); }
      return;
    }
    const owner_email = d.owner_email.trim();
    try {
      const res = await api.registerRestaurant({
        country: SIGNUP_COUNTRY, restaurant_name: d.restaurant_name.trim(), owner_name: d.owner_name.trim(),
        owner_email, owner_password: d.owner_password, trn: trn || undefined, business_types: canonicalTypes(d.business_types),
      });
      if (res && isSignupPending(res)) { // SIGNUP_EMAIL_VERIFICATION on: nothing exists yet, the emailed 6-digit code finishes it
        const t = clockNow(), expiresIn = res.expires_in_seconds ?? 600;
        setPending({ email: res.email || owner_email, expiresIn, expiresAt: t + expiresIn * 1000, resendAt: t + (res.resend_after_seconds ?? DEFAULT_RESEND_SECONDS) * 1000 });
        return;
      }
      if (!res) { setSentTo(owner_email); return; } // a 202 without the code contract: the server confirms the email by link
      done(res); // verification off: the old immediate sign-up (201)
    } catch (e) {
      if (e instanceof ApiError && e.code === "self_register_disabled") { setError("Sign-up is done on the TheChilli.ai website. Use the sign-up page there."); return; }
      // "Email already in use": the same neutral answer as a normal sign-up that needs email confirmation, so this form never
      // tells a stranger whether an address has an account. The mailbox owner gets the explanation by email.
      if (e instanceof ApiError && EMAIL_TAKEN.has(e.code ?? "")) { setSentTo(owner_email); return; }
      setError(e instanceof ApiError ? (e.status === 0 ? "Cannot reach the server. Check your internet connection and try again." : e.status === 429 ? "Too many sign-ups from here. Please wait a while and try again." : e.message) : "Something went wrong. Please try again.");
    }
  }

  function done(tokens: SessionGrant) {
    savePending(null);
    auth.set(tokens);
    router.replace(landingFor("owner")); // the registrant is the owner: Today
  }

  if (pending) {
    return (
      <AuthPage title="Check your email" subtitle="Enter the code we emailed you to finish creating your restaurant." side="register">
        <SignupCodeStep email={pending.email} clock={pending} expiresInSeconds={pending.expiresIn}
          onClockChange={(c) => setPending({ ...pending, ...c })} onVerified={done}
          onBack={() => { setPending(null); setError(null); }} />
      </AuthPage>
    );
  }

  if (sentTo) {
    return (
      <AuthPage title="Check your email" subtitle="One more step before your restaurant is ready." side="register">
        <Notice tone="info">
          We sent a message to <strong>{sentTo}</strong> with the next step. If this email already has an account, the
          message explains how to sign in or reset the password instead. It can take a few minutes; check your spam folder too.
        </Notice>
        <Button variant="primary" size="lg" onClick={() => router.replace("/login")}>Go to login</Button>
      </AuthPage>
    );
  }

  return (
    <AuthPage
      title="Register your restaurant"
      subtitle="For restaurants in India: billing in ₹ with GST. Staff accounts are added later from Manage."
      side="register"
    >
      {error && <Notice tone="danger">{error}</Notice>}
      {appliedTo ? <Notice tone="success">Thank you! We will email {appliedTo} a link to choose your password as soon as your restaurant is ready.</Notice> : (
      <form noValidate method="post" onSubmit={handleSubmit(submit)}>
        <Input variant="pill" label="Owner name" autoComplete="name" error={errors.owner_name?.message} {...register("owner_name")} />
        <Input variant="pill" label="Restaurant name" autoComplete="organization" error={errors.restaurant_name?.message} {...register("restaurant_name")} />
        <fieldset aria-describedby={errors.business_types ? "business-types-error" : undefined} className="mb-4 rounded-2xl border border-border p-3" data-testid="register-business-types">
          <legend className="px-1 text-sm font-semibold text-fg">{TYPES_LEGEND}</legend>
          <div className="space-y-1">
            {catalogue.map((c) => (
              <Checkbox key={c.id} label={c.label} hint={typeHint(c)} checked={picked.includes(c.id)} onChange={(e) => toggleType(c.id, e.target.checked)} />
            ))}
          </div>
          {errors.business_types && <p id="business-types-error" role="alert" className="mt-1 text-sm font-medium text-danger-fg">{errors.business_types.message}</p>}
        </fieldset>
        <Input variant="pill" icon={icons.mail} label="Email" type="email" inputMode="email" autoComplete="email" placeholder="you@example.com" error={errors.owner_email?.message} {...register("owner_email")} />
        {!VIA_ONBOARDING && <PasswordInput variant="pill" label="Password" autoComplete="new-password" hint="At least 10 characters." error={errors.owner_password?.message} {...register("owner_password")} />}
        <Input variant="pill" label="GSTIN (optional)" autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={20}
          hint={gstinHint(gstin)} error={errors.gstin?.message} {...register("gstin")} />
        <Button variant="primary" type="submit" size="lg" loading={isSubmitting}>{VIA_ONBOARDING ? "Sign up" : "Create restaurant"}</Button>
      </form>)}
    </AuthPage>
  );
}
