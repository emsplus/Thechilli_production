import { describe, expect, it } from "vitest";
import { ApiError, isSignupPending } from "./api";
import { emptyCode, fillCode, formatWait, isComplete, resendError, retryAfterOf, verifyErrorMessage } from "./signupCode";

const err = (status: number, message = "", retryAfter?: number) => Object.assign(new ApiError(status, message), { retryAfter });

describe("sign-up code entry", () => {
  it("typing fills one box and moves on", () => {
    const r = fillCode(emptyCode(), 0, "4");
    expect(r.boxes).toEqual(["4", "", "", "", "", ""]);
    expect(r.focus).toBe(1);
    expect(fillCode(r.boxes, 1, "x").boxes).toEqual(r.boxes); // non-digits are ignored, focus stays
    expect(fillCode(r.boxes, 1, "x").focus).toBe(1);
  });
  it("a pasted or autofilled full code fills every box, wherever it lands", () => {
    for (const at of [0, 3, 5]) {
      const r = fillCode(emptyCode(), at, "Your code: 482 913");
      expect(r.boxes.join("")).toBe("482913");
      expect(r.focus).toBe(5);
      expect(isComplete(r.boxes)).toBe(true);
    }
  });
  it("a partial paste fills from the box it lands in", () => {
    const r = fillCode(["1", "2", "", "", "", ""], 2, "34");
    expect(r.boxes).toEqual(["1", "2", "3", "4", "", ""]);
    expect(r.focus).toBe(4);
    expect(isComplete(r.boxes)).toBe(false);
    expect(fillCode(["1", "2", "3", "4", "", ""], 4, "567").boxes.join("")).toBe("123456"); // overflow is dropped
  });
  it("formats the resend wait", () => {
    expect(formatWait(60)).toBe("1:00");
    expect(formatWait(9)).toBe("0:09");
    expect(formatWait(0.2)).toBe("0:01");
    expect(formatWait(-3)).toBe("0:00");
    expect(formatWait(3600)).toBe("60 minutes");
  });
});

describe("register-restaurant answers", () => {
  it("tells the 202 pending sign-up from the old immediate 200/201 session", () => {
    expect(isSignupPending({ status: "verification_required", email: "a@b.in", expires_in_seconds: 600, resend_after_seconds: 60 })).toBe(true);
    expect(isSignupPending({ access_token: "a", token_type: "bearer", expires_in: 900 })).toBe(false); // the BFF grant (no refresh token)
  });
});

describe("sign-up code errors", () => {
  it("every bad code (one 400 for wrong, expired, used up) points at Resend code", () => {
    const m = verifyErrorMessage(err(400, "The code is invalid or has expired. Request a new code."));
    expect(m).toMatch(/wrong or has expired/);
    expect(m).toMatch(/Resend code/);
  });
  it("429 on verify uses Retry-After; 422, offline and 5xx have their own text", () => {
    expect(verifyErrorMessage(err(429, "Too many code attempts. Try again later.", 1800))).toMatch(/Try again in 30 minutes/);
    expect(verifyErrorMessage(err(429))).toMatch(/wait a while/);
    expect(verifyErrorMessage(err(422))).toMatch(/6-digit code/);
    expect(verifyErrorMessage(err(0))).toMatch(/Cannot reach the server/);
    expect(verifyErrorMessage(err(503))).toMatch(/server had a problem/);
    expect(verifyErrorMessage(new Error("x"))).toMatch(/Something went wrong/);
  });
  it("429 on resend restarts the countdown from Retry-After (60 s when absent)", () => {
    expect(resendError(err(429, "Please wait before asking for another code.", 42))).toEqual({ message: "Please wait before asking for another code.", wait: 42 });
    expect(resendError(err(429)).wait).toBe(60);
    const hourly = resendError(err(429, "Too many code requests. Try again later.", 2400));
    expect(hourly.wait).toBe(2400);
    expect(hourly.message).toMatch(/40 minutes/);
    expect(resendError(err(0)).wait).toBeUndefined();
  });
  it("reads retryAfter only when it is a positive number", () => {
    expect(retryAfterOf(err(429, "", 5))).toBe(5);
    expect(retryAfterOf(err(429))).toBeUndefined();
    expect(retryAfterOf(null)).toBeUndefined();
  });
});
