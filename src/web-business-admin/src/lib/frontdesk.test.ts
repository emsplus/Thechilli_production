import { describe, expect, it } from "vitest";
import { availabilityText, bookingProblem, partyProblem, daySummary, hoursText, localInputValue, localStart, reasonOk, timeIn } from "./frontdesk";
import { blankOffer, daysText, gstRateText, groupBody, newRow, offerBody, offerSummary, ruleText, vegOf } from "./menuAdmin";
import type { Reservation } from "./extras";

describe("reservations helpers", () => {
  it("shows API times in the restaurant zone and sends naive local times", () => {
    expect(timeIn("2026-10-31T14:00:00Z", "Asia/Kolkata")).toBe("7:30 PM");
    expect(localInputValue("2026-10-31T03:35:00Z", "Asia/Kolkata")).toBe("2026-10-31T09:05");
    expect(localStart("2026-10-31", "19:30")).toBe("2026-10-31T19:30:00");
  });
  it("checks a booking before sending", () => {
    expect(bookingProblem({ guest: "", phone: "9876543210", party: "2", time: "19:30" })).toMatch(/name/);
    expect(bookingProblem({ guest: "Asha", phone: "12345", party: "2", time: "19:30" })).toMatch(/10-digit/);
    expect(bookingProblem({ guest: "Asha", phone: "98765 43210", party: "0", time: "19:30" })).toMatch(/Party/);
    expect(bookingProblem({ guest: "Asha", phone: "+91 98765 43210", party: "4", time: "19:30" })).toBeNull();
  });
  it("availability and day summary sentences", () => {
    expect(availabilityText({ available_count: 2, party_size: 4, tables: [{ id: "a", label: "T1", seats: 4, area: "indoor", fits: true, available: true, occupied_now: false, conflicts: [] }] })).toBe("2 tables are free for 4 at this time.");
    expect(availabilityText({ available_count: 0, party_size: 9, tables: [{ id: "a", label: "T1", seats: 4, area: "indoor", fits: false, available: true, occupied_now: false, conflicts: [] }] })).toMatch(/No table seats 9/);
    const r = (status: Reservation["status"], party_size: number) => ({ status, party_size }) as Reservation;
    expect(daySummary([r("booked", 2), r("seated", 4), r("cancelled", 6)])).toBe("3 bookings · 6 guests · 1 seated");
  });
  it("hours and reasons", () => {
    expect(hoursText(185)).toBe("3 h 05 m");
    expect(reasonOk("ok")).toBe(false);
    expect(reasonOk("forgot")).toBe(true);
  });
});

describe("menu admin helpers", () => {
  it("modifier group rule text and body validation", () => {
    expect(ruleText({ min_select: 1, max_select: 1 })).toBe("Required · choose 1");
    expect(ruleText({ min_select: 0, max_select: 3 })).toBe("Optional · up to 3");
    expect(ruleText({ min_select: 0, max_select: null })).toBe("Optional · any number");
    const rows = [newRow({ name: "Mild" }), newRow({ name: "Hot", rupees: "20", isDefault: true })];
    const ok = groupBody("Spice level", "1", "1", rows);
    expect("body" in ok && ok.body.options.map((o) => [o.name, o.price_delta_paise, o.is_default])).toEqual([["Mild", 0, false], ["Hot", 2000, true]]);
    expect(groupBody("Spice", "2", "1", rows)).toEqual({ error: "Minimum cannot be more than the maximum" });
    expect(groupBody("Spice", "0", "1", [newRow({ name: "A", isDefault: true }), newRow({ name: "B", isDefault: true })])).toEqual({ error: "At most 1 default option" });
    expect(groupBody("Spice", "0", "", [newRow({ name: "A" }), newRow({ name: "a" })])).toEqual({ error: "a is listed twice" });
  });
  it("offer body: empty days / order types mean every", () => {
    const r = offerBody({ ...blankOffer(), name: "Lunch 10%", value: "10", days: [0, 1, 2, 3, 4], start: "12:00", end: "15:00" });
    expect("body" in r && r.body).toMatchObject({ name: "Lunch 10%", kind: "percent", value: "10", scope: "bill", target_ids: null, days_of_week: [0, 1, 2, 3, 4], start_time: "12:00", end_time: "15:00", order_types: null, min_order_value: "0", max_discount: null });
    expect(offerBody({ ...blankOffer(), name: "X", value: "120" })).toEqual({ error: "A percent offer cannot be more than 100%" });
    expect(offerBody({ ...blankOffer(), name: "X", value: "10", scope: "item" })).toEqual({ error: "Choose at least one dish" });
    expect(offerBody({ ...blankOffer(), name: "X", value: "10", start: "12:00" })).toEqual({ error: "Set both the start and the end time, or neither" });
  });
  it("offer summary and days", () => {
    expect(daysText([0, 1, 2, 3, 4])).toBe("Mon–Fri");
    expect(daysText([5, 6])).toBe("Sat, Sun");
    const money = (v: string) => `₹${Number(v)}`;
    expect(offerSummary({ kind: "percent", value: "10.00", scope: "bill", target_ids: null, min_order_value: "500", max_discount: "100", days_of_week: [0, 1, 2, 3, 4], start_time: "12:00:00", end_time: "15:00:00", order_types: ["indoor"], valid_from: null, valid_to: null, stackable: false }, money))
      .toBe("10% off the bill · Mon–Fri 12:00–15:00 · min ₹500 · up to ₹100 · Dine-in");
  });
  it("GST rate and veg marker on the menu", () => {
    const rates = [{ code: "standard", rate_percent: "5.00" }];
    expect(gstRateText({ gst_rate_code: null }, rates)).toBe("GST 5%");
    expect(gstRateText({ gst_rate_code: "gst_18" }, rates)).toBe("GST 18%");
    expect(gstRateText({ gst_rate_code: "none" }, rates)).toBe("No GST");
    expect(vegOf({ is_veg: true })).toBe("veg");
    expect(vegOf({ food_type: "non_veg" })).toBe("nonveg");
    expect(vegOf({})).toBeNull();
  });
});

describe("Guests field (QA D20)", () => {
  it("refuses what it used to turn into another number", () => {
    for (const v of ["2.5", "-3", "1e3", "2 3", "abc", ""]) expect(partyProblem(v), v).toMatch(/whole number/);
    expect(bookingProblem({ guest: "Asha", phone: "9876543210", party: "2.5", time: "19:30" })).toMatch(/whole number/);
  });
  it("accepts 1 to 500", () => {
    for (const v of ["1", "4", " 12 ", "500"]) expect(partyProblem(v), v).toBeNull();
    for (const v of ["0", "501"]) expect(partyProblem(v), v).toMatch(/1 to 500/);
  });
});
