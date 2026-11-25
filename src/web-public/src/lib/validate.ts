import { gstinProblem, normalizeGstin, stateCodeOf } from "./gstin";
import { normalizeIndianPhone } from "./phone";

import { BUSINESS_TYPE_IDS, type BusinessTypeId } from "./business-types";
export const MAX_OUTLETS = 50;

export interface SignupForm {
  businessTypes: BusinessTypeId[]; businessName: string; outlets: string; city: string; gstin: string;
  ownerName: string; phone: string; email: string; referralCode: string; consent: boolean;
}
export const emptySignup: SignupForm = {
  businessTypes: ["restaurant"], businessName: "", outlets: "1", city: "", gstin: "", ownerName: "", phone: "", email: "", referralCode: "", consent: false,
};
/** Error keys are i18n keys under "err.", so messages follow the language toggle. */
export type ErrorKey = string;
export type Errors = Partial<Record<keyof SignupForm, ErrorKey>>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const REFERRAL = /^[A-Za-z0-9_-]{3,32}$/;

export function validateEmail(v: string): ErrorKey | null {
  const s = v.trim();
  if (!s) return "required";
  return EMAIL.test(s) && s.length <= 254 ? null : "email";
}
export function validatePhone(v: string): ErrorKey | null {
  if (!v.trim()) return "required";
  return normalizeIndianPhone(v) ? null : "phone";
}

export const STEP_FIELDS: (keyof SignupForm)[][] = [
  ["businessTypes"],
  ["businessName", "outlets", "city", "gstin"],
  ["ownerName", "phone", "email", "referralCode", "consent"],
];

export function validateSignup(f: SignupForm, only?: (keyof SignupForm)[]): Errors {
  const e: Errors = {};
  const n = Number(f.outlets);
  if (f.businessName.trim().length < 2) e.businessName = "name";
  if (!f.businessTypes.length || f.businessTypes.some((b) => !BUSINESS_TYPE_IDS.includes(b))) e.businessTypes = "types";
  if (!/^\d+$/.test(f.outlets.trim()) || n < 1 || n > MAX_OUTLETS) e.outlets = "outlets";
  if (!f.city.trim()) e.city = "required";
  const g = gstinProblem(f.gstin);
  if (g) e.gstin = `gstin_${g}`;
  if (f.ownerName.trim().length < 2) e.ownerName = "name";
  const p = validatePhone(f.phone); if (p) e.phone = p;
  const m = validateEmail(f.email); if (m) e.email = m;
  if (f.referralCode.trim() && !REFERRAL.test(f.referralCode.trim())) e.referralCode = "referral";
  if (!f.consent) e.consent = "consent";
  if (!only) return e;
  return Object.fromEntries(Object.entries(e).filter(([k]) => only.includes(k as keyof SignupForm))) as Errors;
}

/** Builds the platform-core ApplicationIn body. Only fields the API declares are sent, plus `business_types`
 * (docs/BUSINESS_TYPES.md: one or more of restaurant, cloud_kitchen, hotel_kitchen, deduplicated, canonical order). */
export function toApplication(f: SignupForm, idempotencyKey: string, planCode?: string) {
  const outlets = Math.min(MAX_OUTLETS, Math.max(1, Number(f.outlets) || 1));
  const city = f.city.trim();
  const gstin = normalizeGstin(f.gstin);
  const ref = f.referralCode.trim();
  return {
    business_types: BUSINESS_TYPE_IDS.filter((b) => f.businessTypes.includes(b)),
    business_name: f.businessName.trim(),
    contact_name: f.ownerName.trim(),
    email: f.email.trim().toLowerCase(),
    phone: normalizeIndianPhone(f.phone) ?? undefined,
    plan_code: planCode || undefined,
    gstin: gstin || undefined,
    state_code: gstin ? stateCodeOf(gstin) : undefined,
    city: city || undefined,
    outlets: Array.from({ length: outlets }, (_, i) => ({ name: `${f.businessName.trim()} outlet ${i + 1}`.slice(0, 200), city: city || undefined })),
    marketing_ref: ref ? `referral:${ref}`.slice(0, 100) : undefined,
    idempotency_key: idempotencyKey,
  };
}
