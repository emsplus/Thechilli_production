import { describe, expect, it } from "vitest";
import {
  browserLabel, canManagePinOf, canRevokeDevice, canSignOutUser, cleanPin, deviceId, deviceTitle, filterByPerson, isStepUpRequired,
  lastSeenText, peopleOf, pinProblem, platformLabel, retryAfterText, sortDevices, monoNow, stepUpFailure, stepUpSecondsLeft, type SignedInDevice,
} from "./devices";

const dev = (o: Partial<SignedInDevice>): SignedInDevice => ({
  id: "d", user_id: "u1", user_name: "Asha", user_role: "waiter", device_id: null, name: null, model: null, platform: null, user_agent: null,
  first_seen_at: null, last_seen_at: null, last_ip: null, revoked_at: null, active: true, current: false, ...o,
});

describe("PIN rules (same as the server)", () => {
  it("accepts 4 to 6 digits that are not trivial", () => {
    for (const p of ["4826", "59371", "802415", "1243", "0907"]) expect(pinProblem(p)).toBeNull();
  });
  it("refuses the wrong length or non-digits", () => {
    for (const p of ["", "123", "1234567", "12a4", " 4826", "48 26"]) expect(pinProblem(p)).toMatch(/4 to 6 digits/);
  });
  it("refuses repeated digits and straight runs both ways", () => {
    expect(pinProblem("1111")).toMatch(/same digit/);
    expect(pinProblem("000000")).toMatch(/same digit/);
    for (const p of ["1234", "98765", "456789", "3210"]) expect(pinProblem(p)).toMatch(/runs/);
    expect(pinProblem("1235")).toBeNull(); // not a straight run
    expect(pinProblem("1357")).toBeNull(); // step 2 is allowed by the server
  });
  it("cleanPin keeps digits only, at most 6", () => {
    expect(cleanPin("12a3-4 5678")).toBe("123456");
    expect(cleanPin("")).toBe("");
  });
});

describe("who may do what", () => {
  const owner = { id: "o", role: "owner", permissions: ["devices.manage", "staff.pin.manage"] };
  const manager = { id: "m", role: "manager", permissions: ["devices.manage", "staff.pin.manage"] };
  const waiter = { id: "w", role: "waiter", permissions: ["orders.create"] };
  it("anyone revokes their own device; others need devices.manage; an owner's only by an owner", () => {
    expect(canRevokeDevice(waiter, { user_id: "w", user_role: "waiter" })).toBe(true);
    expect(canRevokeDevice(waiter, { user_id: "x", user_role: "waiter" })).toBe(false);
    expect(canRevokeDevice(manager, { user_id: "x", user_role: "cashier" })).toBe(true);
    expect(canRevokeDevice(manager, { user_id: "o", user_role: "owner" })).toBe(false);
    expect(canRevokeDevice(owner, { user_id: "o2", user_role: "owner" })).toBe(true);
  });
  it("PIN management: staff.pin.manage, not yourself, an owner's only by an owner", () => {
    expect(canManagePinOf(manager, { id: "w", role: "waiter" })).toBe(true);
    expect(canManagePinOf(manager, { id: "m", role: "manager" })).toBe(false);
    expect(canManagePinOf(manager, { id: "o", role: "owner" })).toBe(false);
    expect(canManagePinOf(owner, { id: "o2", role: "owner" })).toBe(true);
    expect(canManagePinOf(waiter, { id: "x", role: "waiter" })).toBe(false);
  });
  it("sign a person out everywhere: devices.manage, owner rule", () => {
    expect(canSignOutUser(manager, { id: "w", role: "waiter" })).toBe(true);
    expect(canSignOutUser(manager, { id: "o", role: "owner" })).toBe(false);
    expect(canSignOutUser(waiter, { id: "x", role: "waiter" })).toBe(false);
  });
  it("an older server without a permission list falls back to owner / manager", () => {
    expect(canManagePinOf({ id: "m", role: "manager" }, { id: "w", role: "waiter" })).toBe(true);
    expect(canManagePinOf({ id: "c", role: "cashier" }, { id: "w", role: "waiter" })).toBe(false);
  });
});

describe("display", () => {
  it("labels browsers from the User-Agent", () => {
    expect(browserLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36")).toBe("Chrome on Mac");
    expect(browserLabel("Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36")).toBe("Chrome on Android");
    expect(browserLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1")).toBe("Safari on iPhone");
    expect(browserLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0")).toBe("Edge on Windows");
    expect(browserLabel("okhttp/4.12")).toBe("Browser");
    expect(browserLabel(null)).toBe("Web browser");
  });
  it("device title: name, then model, then the browser", () => {
    expect(deviceTitle({ name: "Asha's phone", model: "Pixel 7", user_agent: null })).toBe("Asha's phone");
    expect(deviceTitle({ name: " ", model: "Pixel 7", user_agent: null })).toBe("Pixel 7");
    expect(deviceTitle({ name: null, model: null, user_agent: "Mozilla/5.0 (Windows NT 10.0) Firefox/130.0" })).toBe("Firefox on Windows");
  });
  it("platform labels", () => {
    expect(platformLabel("android")).toBe("Android");
    expect(platformLabel("WEB")).toBe("Web browser");
    expect(platformLabel("tizen")).toBe("tizen");
    expect(platformLabel(null)).toBe("Unknown");
  });
  it("last seen is relative, then a date", () => {
    const now = Date.parse("2026-11-01T12:00:00Z");
    expect(lastSeenText("2026-11-01T11:59:40Z", now)).toBe("Just now");
    expect(lastSeenText("2026-11-01T11:55:00Z", now)).toBe("5 min ago");
    expect(lastSeenText("2026-11-01T09:00:00Z", now)).toBe("3 h ago");
    expect(lastSeenText("2026-10-31T10:00:00Z", now)).toBe("Yesterday");
    expect(lastSeenText("2026-10-28T10:00:00Z", now)).toBe("4 days ago");
    expect(lastSeenText("2026-09-01T10:00:00Z", now)).toMatch(/2026/);
    expect(lastSeenText(null, now)).toBe("Never");
    expect(lastSeenText("garbage", now)).toBe("Unknown");
  });
  it("retry-after wording", () => {
    expect(retryAfterText(1)).toBe("Try again in 1 second.");
    expect(retryAfterText(45)).toBe("Try again in 45 seconds.");
    expect(retryAfterText(900)).toBe("Try again in 15 minutes.");
    expect(retryAfterText(5400)).toBe("Try again in 2 hours.");
    expect(retryAfterText(undefined)).toBe("Try again later.");
  });
});

describe("lists", () => {
  const list = [
    dev({ id: "a", user_id: "u2", user_name: "Ravi", active: false, last_seen_at: "2026-10-30T10:00:00Z" }),
    dev({ id: "b", user_id: "u1", user_name: "Asha", active: true, last_seen_at: "2026-10-29T10:00:00Z" }),
    dev({ id: "c", user_id: "u1", user_name: "Asha", active: true, current: true, last_seen_at: "2026-10-01T10:00:00Z" }),
    dev({ id: "d", user_id: "u3", user_name: null, active: true, last_seen_at: "2026-10-31T10:00:00Z" }),
  ];
  it("sorts this device first, then signed-in, then most recent", () => {
    expect(sortDevices(list).map((d) => d.id)).toEqual(["c", "d", "b", "a"]);
  });
  it("people for the filter, by name, once each", () => {
    expect(peopleOf(list).map((p) => p.name)).toEqual(["Asha", "Ravi", "Unnamed"]);
  });
  it("filters by person", () => {
    expect(filterByPerson(list, "u1").map((d) => d.id)).toEqual(["b", "c"]);
    expect(filterByPerson(list, "")).toHaveLength(4);
  });
});

describe("step-up", () => {
  it("recognises the step-up answer by code or by message", () => {
    expect(isStepUpRequired({ status: 403, code: "step_up_required", message: "x" })).toBe(true);
    expect(isStepUpRequired({ status: 403, message: "Re-enter your PIN to void a bill (step-up required)" })).toBe(true);
    expect(isStepUpRequired({ status: 403, message: "Not allowed" })).toBe(false);
    expect(isStepUpRequired({ status: 401, code: "step_up_required" })).toBe(false);
    expect(isStepUpRequired(null)).toBe(false);
  });
  it("seconds left on a grant: a duration on the monotonic clock, never the wall clock", () => {
    expect(stepUpSecondsLeft({ expires_in: 300, received: 1000 }, 1000)).toBe(300);
    expect(stepUpSecondsLeft({ expires_in: 300, received: 1000 }, 1000 + 120_000)).toBe(180);
    expect(stepUpSecondsLeft({ expires_in: 300, received: 1000 }, 1000 + 299_500)).toBe(0);
    expect(stepUpSecondsLeft({ expires_in: 300, received: 1000 }, 1000 + 400_000)).toBe(0);
    expect(stepUpSecondsLeft(null, 5)).toBe(0);
  });
  it("a device clock 10 minutes ahead (or behind) does not change a fresh grant (QA review M1)", () => {
    const realNow = Date.now;
    try {
      for (const skew of [10 * 60_000, -10 * 60_000, 3 * 3600_000]) {
        Date.now = () => realNow() + skew; // the wall clock is wrong; the grant has an expires_at of the server's time
        const g = { expires_in: 300, expires_at: new Date(realNow() + 300_000).toISOString(), received: monoNow() } as { expires_in: number; received: number };
        expect(stepUpSecondsLeft(g)).toBeGreaterThanOrEqual(299);
      }
    } finally { Date.now = realNow; }
  });
  it("failure messages", () => {
    expect(stepUpFailure(401, { attemptsLeft: 3, method: "pin" })).toBe("Wrong PIN. 3 attempts left before it locks.");
    expect(stepUpFailure(401, { attemptsLeft: 1, method: "pin" })).toBe("Wrong PIN. 1 attempt left before it locks.");
    expect(stepUpFailure(401, { method: "password" })).toBe("Wrong password.");
    expect(stepUpFailure(429, { retryAfter: 900, method: "pin" })).toBe("Too many wrong attempts. Try again in 15 minutes. A manager can unlock your PIN.");
    expect(stepUpFailure(500, { message: "Boom", method: "pin" })).toBe("Boom");
  });
});

describe("device id", () => {
  it("is created once and reused", () => {
    const m = new Map<string, string>();
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    const a = deviceId(store);
    expect(a).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
    expect(deviceId(store)).toBe(a);
  });
  it("ignores a tampered value", () => {
    const store = { getItem: () => "<script>", setItem: () => undefined };
    expect(deviceId(store)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
