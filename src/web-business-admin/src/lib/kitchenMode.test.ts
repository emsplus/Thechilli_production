import { describe, expect, it } from "vitest";
import { canLeaveKiosk, kitchenMode } from "./kitchenMode";

describe("kitchen routing", () => {
  it("kitchen users always get the full-screen kiosk", () => {
    expect(kitchenMode("kitchen", false)).toBe("kiosk");
    expect(kitchenMode("kitchen", true)).toBe("kiosk");
    expect(canLeaveKiosk("kitchen")).toBe(false);
  });
  it("owner and manager open the kitchen inside the shell unless they chose full screen", () => {
    for (const r of ["owner", "manager", "cashier", "waiter", "unknown"] as const) {
      expect(kitchenMode(r, false)).toBe("shell");
      expect(kitchenMode(r, true)).toBe("kiosk");
      expect(canLeaveKiosk(r)).toBe(true);
    }
  });
  it("while the role loads, the kiosk is assumed (no navigation flash on the kitchen tablet)", () => {
    expect(kitchenMode(null, false)).toBe("kiosk");
  });
});
