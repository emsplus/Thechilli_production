import { describe, expect, it } from "vitest";
import { readInviteToken } from "./invite";

const T = "6b1c2d3e-0000-4000-8000-000000000001.abcdefghijklmnopqrstuvwxyz";

describe("readInviteToken", () => {
  it("reads the fragment (staff invites) and the query (owner invites)", () => {
    expect(readInviteToken("", `#token=${T}`)).toBe(T);
    expect(readInviteToken(`?token=${encodeURIComponent(T)}`, "")).toBe(T);
  });
  it("ignores missing or short tokens", () => {
    expect(readInviteToken("", "")).toBeNull();
    expect(readInviteToken("?token=short", "")).toBeNull();
  });
});
