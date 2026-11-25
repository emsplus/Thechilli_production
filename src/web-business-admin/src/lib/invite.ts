/** Token of an invite link: `#token=` (staff invites from pos-service) or `?token=` (owner invites from platform-core). */
export function readInviteToken(search: string, hash: string): string | null {
  const h = new URLSearchParams(hash.replace(/^#/, "")).get("token");
  const q = new URLSearchParams(search).get("token");
  const t = (h || q || "").trim();
  return t.length >= 20 ? t : null;
}

/** Platform-core onboarding (the ONE production sign-up path); unset = the direct pos-service sign-up (local / e2e only). */
export const ONBOARDING_API = process.env.NEXT_PUBLIC_ONBOARDING_API_URL ?? "";

export interface ApplicationIn { business_name: string; contact_name: string; email: string; gstin?: string; business_types: string[]; idempotency_key: string }

/** POST {ONBOARDING_API}/onboarding/applications (anonymous self-signup). The owner gets a set-password email once the
 *  restaurant is provisioned (auto-approved or after review, platform-core policy). 429 = too many from this address. */
export async function submitApplication(body: ApplicationIn): Promise<{ status?: string; duplicate?: boolean }> {
  const res = await fetch(`${ONBOARDING_API.replace(/\/$/, "")}/onboarding/applications`, {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": body.idempotency_key }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = typeof data?.detail === "string" ? data.detail : data?.error?.message;
    throw Object.assign(new Error(res.status === 429 ? "Too many sign-ups from this network. Try again in an hour." : msg || "Sign-up failed. Please try again."), { status: res.status });
  }
  return data;
}
