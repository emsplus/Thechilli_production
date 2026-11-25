import { describe, expect, it } from "vitest";
import { emailSchema, pwSchema, readResetLink, resetSchema } from "./passwords";

describe("password helpers", () => {
  it("reads the reset link: restaurant from the query, token from the fragment", () => {
    expect(readResetLink("?r=abc-123", "#t=tok_en")).toEqual({ restaurantId: "abc-123", token: "tok_en" });
    expect(readResetLink("", "")).toEqual({ restaurantId: null, token: null });
    expect(readResetLink("?r=abc", "#x=1")).toEqual({ restaurantId: "abc", token: null });
  });
  it("needs 10 characters and a matching repeat", () => {
    expect(resetSchema.safeParse({ next: "short", again: "short" }).success).toBe(false);
    expect(resetSchema.safeParse({ next: "longenough1", again: "different12" }).success).toBe(false);
    expect(resetSchema.safeParse({ next: "longenough1", again: "longenough1" }).success).toBe(true);
    expect(pwSchema.safeParse({ current: "", next: "longenough1", again: "longenough1" }).success).toBe(false);
  });
  it("validates the email", () => {
    expect(emailSchema.safeParse({ email: "nope" }).success).toBe(false);
    expect(emailSchema.safeParse({ email: " a@b.in " }).success).toBe(true);
  });
});
