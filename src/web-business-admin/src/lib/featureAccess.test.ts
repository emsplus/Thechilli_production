import { describe, expect, it } from "vitest";
import { capabilitiesOf, featureOf } from "./useRole";
import type { Me } from "./types";

const me = (extra: Partial<Me>): Me => ({ id: "u", email: "o@a.in", full_name: "O", role: "owner", is_active: true, permissions: ["settings.owner"], ...extra } as Me);

describe("featureOf: super admin's entitlement AND the owner's switch", () => {
  it("an older server (no features, no entitlements) allows everything", () => {
    const c = capabilitiesOf(me({}));
    expect(c.access).toBeNull();
    expect(featureOf(c, "reports")).toBe(true);
  });
  it("the server's effective map hides what is false and keeps what is true or unknown", () => {
    const c = capabilitiesOf(me({ features: { reports: false, "order.takeaway": true } }));
    expect(featureOf(c, "reports")).toBe(false);
    expect(featureOf(c, "order.takeaway")).toBe(true);
    expect(featureOf(c, "customers")).toBe(true); // a code the server did not mention = allowed
  });
  it("a plan that withholds a feature still hides it (the old entitlement rule is kept)", () => {
    const c = capabilitiesOf(me({ entitlements: { features: { inventory: { enabled: false, limit: null } } }, features: { inventory: true } }));
    expect(featureOf(c, "inventory")).toBe(false);
  });
  it("either layer alone is enough to hide", () => {
    const c = capabilitiesOf(me({ entitlements: { features: { "billing.discount": { enabled: true, limit: null } } }, features: { "billing.discount": false } }));
    expect(featureOf(c, "billing.discount")).toBe(false);
  });
});
