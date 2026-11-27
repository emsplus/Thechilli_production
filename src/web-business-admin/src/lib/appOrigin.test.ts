import { describe, expect, it } from "vitest";
import { isAppOrigin, staffLoginHref } from "./appOrigin";

describe("appOrigin", () => {
  it("accepts only the app's own local origins", () => {
    for (const ok of ["https://localhost", "http://localhost", "http://localhost:3000", "capacitor://localhost"]) expect(isAppOrigin(ok)).toBe(true);
    for (const bad of ["https://evil.com", "https://localhost.evil.com", "http://localhost@evil.com", "javascript:alert(1)", "https://localhost/x", "", null, undefined]) expect(isAppOrigin(bad)).toBe(false);
  });
  it("builds the staff sign-in link", () => { expect(staffLoginHref("https://localhost")).toBe("https://localhost/?mode=staff"); });
});
