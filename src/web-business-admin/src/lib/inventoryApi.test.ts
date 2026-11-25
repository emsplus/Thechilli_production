import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { buildReceiptLines, daysToExpiry, expiryState, fefoSort, isMissing, isQty, lineNet, poActions, remainingQty } from "./inventoryApi";

const today = new Date(2026, 9, 31);

describe("expiry", () => {
  it("counts whole calendar days", () => {
    expect(daysToExpiry("2026-10-31", today)).toBe(0);
    expect(daysToExpiry("2026-11-07", today)).toBe(7);
    expect(daysToExpiry("2026-10-30", today)).toBe(-1);
    expect(daysToExpiry(null, today)).toBeNull();
  });
  it("classifies expired / soon / ok / none", () => {
    expect(expiryState({ expiry_date: "2026-10-30", expired: false }, 7, today)).toBe("expired");
    expect(expiryState({ expiry_date: "2026-11-01", expired: true }, 7, today)).toBe("expired");
    expect(expiryState({ expiry_date: "2026-11-07", expired: false }, 7, today)).toBe("soon");
    expect(expiryState({ expiry_date: "2026-11-08", expired: false }, 7, today)).toBe("ok");
    expect(expiryState({ expiry_date: null, expired: false }, 7, today)).toBe("none");
  });
  it("sorts first-expiry-first-out, undated last, then oldest", () => {
    const b = (id: string, e: string | null, r: string) => ({ id, expiry_date: e, received_at: r });
    const out = fefoSort([b("c", null, "2026-01-01"), b("b", "2026-12-01", "2026-02-01"), b("a", "2026-11-01", "2026-03-01"), b("d", "2026-12-01", "2026-01-15")]);
    expect(out.map((x) => x.id)).toEqual(["a", "d", "b", "c"]);
  });
});

describe("quantities", () => {
  it("computes the quantity left on a PO line exactly", () => {
    expect(remainingQty({ quantity: "10", received_quantity: "2.5" })).toBe("7.5");
    expect(remainingQty({ quantity: "0.3", received_quantity: "0.1" })).toBe("0.2");
    expect(remainingQty({ quantity: "5", received_quantity: "5" })).toBe("0");
    expect(remainingQty({ quantity: "5", received_quantity: "6" })).toBe("0");
  });
  it("validates quantities", () => {
    expect(isQty("1.25")).toBe(true);
    expect(isQty("0")).toBe(false);
    expect(isQty("0", true)).toBe(true);
    expect(isQty("1.2345")).toBe(false);
    expect(isQty("-1")).toBe(false);
  });
  it("multiplies without floats", () => {
    expect(lineNet("3", "12.5")).toBe("37.5000");
    expect(lineNet("0.1", "0.3")).toBe("0.0300");
    expect(lineNet("x", "1")).toBe("0");
  });
});

describe("purchase order rules", () => {
  it("mirrors the server status rules", () => {
    expect(poActions("draft", false)).toMatchObject({ edit: true, send: true, cancel: true, receive: false });
    expect(poActions("sent", false)).toMatchObject({ cancel: true, receive: true, edit: false });
    expect(poActions("sent", true).cancel).toBe(false);
    expect(poActions("partially_received", true)).toMatchObject({ close: true, receive: true, cancel: false });
    expect(poActions("closed", true)).toMatchObject({ receive: false, close: false });
  });
  it("builds receipt lines from rows, skipping empty ones", () => {
    const lines = buildReceiptLines([
      { po_line_id: "a", accepted: "5", rejected: "1", rate: "", batch_no: " B1 ", expiry: "2026-12-01" },
      { po_line_id: "b", accepted: "", rejected: "", rate: "", batch_no: "", expiry: "" },
      { po_line_id: "c", accepted: "2", rejected: "x", rate: "9.5", batch_no: "", expiry: "" },
    ]);
    expect(lines).toEqual([
      { po_line_id: "a", quantity: "5", rejected_quantity: "1", batch_no: "B1", expiry_date: "2026-12-01" },
      { po_line_id: "c", quantity: "2", rejected_quantity: "0", unit_price: "9.5" },
    ]);
  });
});

describe("missing endpoints", () => {
  it("treats 404, 405 and 501 as missing, nothing else", () => {
    expect(isMissing(new ApiError(404, "x"))).toBe(true);
    expect(isMissing(new ApiError(405, "x"))).toBe(true);
    expect(isMissing(new ApiError(501, "x"))).toBe(true);
    expect(isMissing(new ApiError(500, "x"))).toBe(false);
    expect(isMissing(new Error("x"))).toBe(false);
  });
});
