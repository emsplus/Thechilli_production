import type { PlanOut } from "@/lib/api/types";

/** STATIC FALLBACK. Mirrors the dev catalog in platform-core scripts/seed_catalog.py: prices are placeholders (paise, excl. GST),
 *  not commercial decisions. Pricing copy says "indicative" until the owner confirms. */
export interface StaticPlan { code: string; name: string; pricePaise: number; outlets: number; popular?: boolean; features: { code: string; limit?: number }[] }
export const PLANS: StaticPlan[] = [
  { code: "starter", name: "Starter", pricePaise: 99900, outlets: 1, features: [{ code: "pos.core" }, { code: "outlets.max", limit: 1 }] },
  { code: "growth", name: "Growth", pricePaise: 249900, outlets: 5, popular: true, features: [{ code: "pos.core" }, { code: "outlets.max", limit: 5 }, { code: "kds" }, { code: "inventory" }] },
  { code: "pro", name: "Pro", pricePaise: 499900, outlets: 25, features: [{ code: "pos.core" }, { code: "outlets.max", limit: 25 }, { code: "kds" }, { code: "inventory" }, { code: "ai.copilot" }, { code: "marketing.campaigns" }] },
];
export const FEATURE_LABEL_KEYS: Record<string, string> = {
  "pos.core": "plan.f.pos", "outlets.max": "plan.f.outlets", kds: "plan.f.kds", inventory: "plan.f.inventory", "ai.copilot": "plan.f.ai", "marketing.campaigns": "plan.f.campaigns",
};

/** Maps an API plan list to the display shape; unknown plans are kept, flags drive the feature list. */
export function fromApi(items: PlanOut[]): StaticPlan[] {
  return items.map((p) => {
    const lim = p.features.find((f) => f.feature_code === "outlets.max")?.limit_value ?? 0;
    return {
      code: p.code, name: p.name, pricePaise: p.price_paise, outlets: lim,
      popular: p.code === "growth",
      features: p.features.filter((f) => f.enabled).map((f) => ({ code: f.feature_code, limit: f.limit_value ?? undefined })),
    };
  });
}
