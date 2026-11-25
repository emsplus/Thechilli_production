import { msg, type Locale } from "./i18n";
import { OUTLETS_MSG } from "@/app/manage/_components/outlets-messages";
import type { Me, Outlet } from "./types";

/** What the plan allows: `null` = unlimited / not told (absent = allow), `0` = none. Counts active outlets only (the server's rule). */
export interface OutletQuota { limit: number | null; used: number; reached: boolean }
export function outletQuota(me: Pick<Me, "entitlements">, outlets: Outlet[]): OutletQuota {
  const raw = me.entitlements?.outlet_limit;
  const limit = typeof raw === "number" ? raw : null;
  const used = outlets.filter((o) => o.is_active).length;
  return { limit, used, reached: limit !== null && used >= limit };
}

export function quotaText(q: OutletQuota, locale: Locale = "en"): string {
  if (q.limit === null) return msg(locale, q.used === 1 ? OUTLETS_MSG.quotaActiveOne : OUTLETS_MSG.quotaActiveMany, { n: q.used });
  return msg(locale, q.limit === 1 ? OUTLETS_MSG.quotaUseOne : OUTLETS_MSG.quotaUseMany, { used: q.used, limit: q.limit });
}

/** Indian invoice numbers must stay within 16 characters, so a prefix is at most 4 characters (pos-service docs/INDIA.md). */
export const MAX_PREFIX_LENGTH = 4;
export const cleanCode = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** The plan-limit sentence in the given language (English by default). */
export const limitMessage = (locale: Locale = "en") => msg(locale, OUTLETS_MSG.limitMessage);
export const LIMIT_MESSAGE = limitMessage();
