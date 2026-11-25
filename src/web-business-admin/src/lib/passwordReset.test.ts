import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanCode, formatCountdown, isFullCode, policyMessage, resetApi, resetModeOf, ResetError, retryAfterSeconds } from "./passwordReset";

describe("resetModeOf", () => {
  it("reads the code flow from the server's wording", () => {
    expect(resetModeOf({ detail: "If an account exists for this email, we have sent a code to it." })).toBe("otp");
  });
  it("reads the link flow (link mode, older servers)", () => {
    expect(resetModeOf({ detail: "If an account exists for this email, a reset link has been sent." })).toBe("link");
  });
  it("prefers an explicit mode field and resend_after_seconds", () => {
    expect(resetModeOf({ mode: "otp", detail: "a reset link" })).toBe("otp");
    expect(resetModeOf({ mode: "link" })).toBe("link");
    expect(resetModeOf({ resend_after_seconds: 60 })).toBe("otp");
  });
  it("falls back to link mode for empty or unknown answers", () => {
    expect(resetModeOf(undefined)).toBe("link");
    expect(resetModeOf({ ok: true })).toBe("link");
    expect(resetModeOf("text")).toBe("link");
  });
});

describe("helpers", () => {
  it("retryAfterSeconds: seconds, HTTP date, missing, clamped", () => {
    expect(retryAfterSeconds("42")).toBe(42);
    expect(retryAfterSeconds(null)).toBe(60);
    expect(retryAfterSeconds("nonsense", 30)).toBe(30);
    expect(retryAfterSeconds("0")).toBe(1);
    expect(retryAfterSeconds("99999")).toBe(3600);
    const now = Date.parse("2026-11-01T10:00:00Z");
    expect(retryAfterSeconds("Sun, 01 Nov 2026 10:00:30 GMT", 60, now)).toBe(30);
  });
  it("cleanCode keeps 6 digits from pasted text", () => {
    expect(cleanCode("123 456")).toBe("123456");
    expect(cleanCode("12-34-56-78")).toBe("123456");
    expect(cleanCode("ab1")).toBe("1");
    expect(isFullCode("123456")).toBe(true);
    expect(isFullCode("12345")).toBe(false);
  });
  it("formatCountdown", () => {
    expect(formatCountdown(60)).toBe("1:00");
    expect(formatCountdown(5)).toBe("0:05");
    expect(formatCountdown(-3)).toBe("0:00");
  });
  it("policyMessage strips pydantic's prefix", () => {
    expect(policyMessage("Value error, Use at least 10 characters.")).toBe("Use at least 10 characters.");
    expect(policyMessage("This password is too common.")).toBe("This password is too common.");
  });
});

describe("resetApi (fetch mocked)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } }));

  it("request -> otp mode with the resend gap", async () => {
    const f = reply(200, { detail: "If an account exists for this email, we have sent a code to it." });
    vi.stubGlobal("fetch", f);
    await expect(resetApi.request("a@b.in")).resolves.toEqual({ mode: "otp", resendAfter: 60 });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/auth\/forgot-password$/);
    expect(JSON.parse(String(init.body))).toEqual({ email: "a@b.in" });
  });
  it("429 carries Retry-After", async () => {
    vi.stubGlobal("fetch", reply(429, { detail: "Please wait before asking for another code." }, { "Retry-After": "37" }));
    const e = await resetApi.request("a@b.in").catch((x) => x);
    expect(e).toBeInstanceOf(ResetError);
    expect(e.status).toBe(429);
    expect(e.retryAfter).toBe(37);
  });
  it("verify returns the reset token; a wrong code is a 400", async () => {
    vi.stubGlobal("fetch", reply(200, { reset_token: "t".repeat(32), expires_in_seconds: 600 }));
    await expect(resetApi.verify("a@b.in", "123456")).resolves.toMatchObject({ expires_in_seconds: 600 });
    vi.stubGlobal("fetch", reply(400, { detail: "The code is invalid or has expired. Request a new code." }));
    await expect(resetApi.verify("a@b.in", "000000")).rejects.toMatchObject({ status: 400 });
  });
  it("complete: 204 resolves; 422 keeps the policy message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    await expect(resetApi.complete("a@b.in", "t".repeat(32), "a long new pass")).resolves.toBeUndefined();
    vi.stubGlobal("fetch", reply(422, { detail: [{ loc: ["body", "new_password"], msg: "Value error, This password is too common. Choose something less predictable.", type: "value_error" }] }));
    const e = await resetApi.complete("a@b.in", "t".repeat(32), "password123").catch((x) => x);
    expect(e.status).toBe(422);
    expect(policyMessage(e.message)).toBe("This password is too common. Choose something less predictable.");
  });
});
