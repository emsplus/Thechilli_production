import { describe, expect, it } from "vitest";
import { getMode, isAdminRole, setMode } from "./adminUrl";
describe("adminUrl", () => {
  it("only owner and manager go to the admin app", () => {
    expect(isAdminRole("owner")).toBe(true);
    expect(isAdminRole("manager")).toBe(true);
    for (const r of ["waiter", "cashier", "kitchen", "", null, undefined]) expect(isAdminRole(r)).toBe(false);
  });
  it("remembers the last mode per device and ignores junk", () => {
    const m = new Map<string, string>();
    (globalThis as unknown as { localStorage: unknown }).localStorage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    expect(getMode()).toBeNull();
    setMode("admin"); expect(getMode()).toBe("admin");
    setMode("staff"); expect(getMode()).toBe("staff");
    m.set("chilli.mode", "x"); expect(getMode()).toBeNull();
  });
});
