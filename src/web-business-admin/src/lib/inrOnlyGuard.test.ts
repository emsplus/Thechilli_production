import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/** The INR / India-only guard (scripts/check-inr-only.sh) must pass: no foreign currency, locale, country or tax term. */
describe("INR-only guard", () => {
  it("finds nothing", () => {
    let out = "";
    try { out = execFileSync("bash", ["scripts/check-inr-only.sh"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { out = String((e as { stdout?: string }).stdout ?? e); }
    expect(out.trim()).toBe("INR-only guard: clean");
  }, 30_000);
});
