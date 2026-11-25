import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, announceSessionExpired } from "./api";
import { friendlyError, isNothingToSend } from "./orderErrors";
import { isSafePath } from "./returnTo";

describe("session gone while the cashier acts (QA D25)", () => {
  it("a 401 never shows the server's raw 'Not authenticated'", () => {
    // the pos-service answers {"detail":{"code":"not_authenticated","message":"Not authenticated"}}-style bodies; a code + a short message used to be shown as the title
    const f = friendlyError(new ApiError(401, "Not authenticated", "not_authenticated"));
    expect(f.title).toBe("Session expired, sign in again");
    expect(f.hint).toMatch(/saved/);
    expect(f.retry).toBe(false);
    expect(friendlyError(new ApiError(401, "Not authenticated")).title).toBe("Session expired, sign in again");
  });
  it("other 4xx codes keep their own words", () => {
    expect(friendlyError(new ApiError(409, "That table is taken", "table_has_open_order")).title).toMatch(/table already has an order/);
  });
});

describe("announceSessionExpired", () => {
  const w = globalThis as unknown as { window?: unknown };
  afterEach(() => { delete w.window; });
  it("is false when no screen answers, true when a screen calls preventDefault", () => {
    expect(announceSessionExpired()).toBe(false); // no window (node): nothing to show
    const listeners: ((e: Event) => void)[] = [];
    w.window = { dispatchEvent: (e: Event) => { for (const l of listeners) l(e); return !e.defaultPrevented; }, addEventListener: () => {} };
    expect(announceSessionExpired()).toBe(false); // nobody listening
    listeners.push((e) => e.preventDefault());
    expect(announceSessionExpired()).toBe(true);
    vi.restoreAllMocks();
  });
});

describe("return to the counter after signing in", () => {
  it("only follows plain same-site paths", () => {
    expect(isSafePath("/pos")).toBe(true);
    for (const p of ["//evil.com", "https://evil.com", "/login", "/login/x", "javascript:alert(1)", "", null, "/pos?x=1"]) expect(isSafePath(p), String(p)).toBe(false);
  });
});

describe("send to kitchen twice from two tabs (QA D26)", () => {
  it("recognises the server's 409 'already in the kitchen'", () => {
    expect(isNothingToSend(new ApiError(409, "Everything on this order is already in the kitchen"))).toBe(true);
    expect(isNothingToSend(new ApiError(409, "This order changed"))).toBe(false);
    expect(isNothingToSend(new ApiError(500, "Everything on this order is already in the kitchen"))).toBe(false);
    expect(friendlyError(new ApiError(409, "Everything on this order is already in the kitchen")).title).toMatch(/already in the kitchen/);
  });
});
