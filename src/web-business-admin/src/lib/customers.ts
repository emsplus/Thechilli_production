import { CUSTOMERS_MSG } from "@/components/customers/messages";
import { api, ApiError } from "./api";
import { msg, type Locale } from "./i18n";
import type { Customer } from "./types";

/** What every screen shows for a customer: the name, or the phone number for a nameless one. */
export const customerLabel = (c: Pick<Customer, "name" | "phone"> & { display_name?: string }, locale: Locale = "en") => c.display_name || c.name || c.phone || msg(locale, CUSTOMERS_MSG.customer);

/** Placeholder / hint for a phone field: an Indian mobile (the server normalises to +91). */
export const phoneHint = (locale: Locale = "en") => msg(locale, CUSTOMERS_MSG.phoneHintIn);

/**
 * Light client-side check before asking the server (which does the real E.164 normalisation by country):
 * only digits, spaces, + ( ) - . and 8-15 digits. Blank = no phone (allowed when a name is given).
 */
export function phoneProblem(raw: string, locale: Locale = "en"): string | null {
  const v = raw.trim();
  if (!v) return null;
  const digits = v.replace(/\D/g, "");
  if (!/^[\d\s()+\-.]+$/.test(v) || digits.length < 8 || digits.length > 15) return msg(locale, CUSTOMERS_MSG.phoneBadIn);
  return null;
}

/** True when a search text looks like a phone number rather than a name (used to prefill the right field). */
export const looksLikePhone = (q: string) => /^[\d\s()+\-.]+$/.test(q.trim()) && q.replace(/\D/g, "").length >= 3;

/**
 * Creates a customer; when the phone already belongs to a customer (409) that existing customer is returned instead.
 * Name and phone are each optional, at least one is required.
 */
export async function createOrFindCustomer(b: { name?: string; phone?: string; email?: string }): Promise<{ customer: Customer; existed: boolean }> {
  const name = b.name?.trim() || null;
  const phone = b.phone?.trim() || null;
  const email = b.email?.trim() || null;
  try {
    return { customer: await api.createCustomer({ name, phone, ...(email ? { email } : {}) }), existed: false };
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 409 && phone)) throw e;
    const digits = phone.replace(/\D/g, "").replace(/^0+/, "");
    const found = (await api.customers(phone)).filter((c) => c.phone);
    const hit = found.find((c) => c.phone!.replace(/\D/g, "").endsWith(digits)) ?? found[0];
    if (!hit) throw e;
    return { customer: hit, existed: true };
  }
}
