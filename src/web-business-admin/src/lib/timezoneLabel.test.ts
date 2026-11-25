import { describe, expect, it } from "vitest";
import { timezoneLabel } from "./timezoneLabel";
import { subtitleFor } from "./restaurantMeta";

describe("timezoneLabel", () => {
  it("uses the backend's timezone_label when present", () => { expect(timezoneLabel("Asia/Kolkata", "India (IST)")).toBe("India (IST)"); expect(timezoneLabel("Asia/Kolkata", " Bharat (IST) ")).toBe("Bharat (IST)"); });
  it("falls back to the frontend mapping when the field is missing, null or blank", () => {
    for (const l of [undefined, null, "", "  "]) expect(timezoneLabel("Asia/Kolkata", l)).toBe("India (IST)");
    expect(timezoneLabel("Asia/Calcutta")).toBe("India (IST)");
  });
  it("never shows a city for the India zone", () => { expect(timezoneLabel("Asia/Kolkata")).not.toMatch(/Kolkata/); });
  it("an unmapped zone is shown as its name, an absent zone as nothing", () => {
    expect(timezoneLabel("Asia/Some_Place")).toBe("Asia/Some Place");
    expect(timezoneLabel(undefined)).toBe("");
    expect(timezoneLabel("")).toBe("");
  });
});

describe("header subtitle", () => {
  it("is 'India (IST) · INR' for a Bengaluru restaurant, with or without timezone_label", () => {
    expect(subtitleFor("INR", "Asia/Kolkata")).toBe("India (IST) · INR");
    expect(subtitleFor("inr", "Asia/Kolkata", "India (IST)")).toBe("India (IST) · INR");
  });
  it("copes with missing parts", () => { expect(subtitleFor("INR", undefined)).toBe("INR"); expect(subtitleFor(undefined, "Asia/Kolkata")).toBe("India (IST)"); });
});
