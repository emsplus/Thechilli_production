import { describe, expect, it } from "vitest";
import { keepKnownRole } from "./useRole";

// The sidebar dropped End of day and Manage when a /auth/me lookup failed or was slow: a failed lookup must not replace a known role.
describe("keepKnownRole", () => {
  it("a failed lookup (null) keeps the role we know", () => {
    expect(keepKnownRole("owner", null)).toBe("owner");
  });
  it("a real answer replaces it, including offline", () => {
    expect(keepKnownRole("owner", "cashier")).toBe("cashier");
    expect(keepKnownRole("owner", "unknown")).toBe("unknown");
    expect(keepKnownRole(null, "manager")).toBe("manager");
    expect(keepKnownRole(null, null)).toBeNull();
  });
});
