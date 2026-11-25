import { describe, expect, it } from "vitest";
import { toCsv } from "./csv";
import { fileSafe, qrFileName, reviewCsvRows, reviewQuery, stars, type Review } from "./tableQr";

const rv = (o: Partial<Review>): Review => ({ id: "1", created_at: "2026-11-02T08:00:00Z", rating: 4, comment: null, guest_name: null, guest_contact: null,
  table_id: "t1", table_label: "T1", read: false, ...o });

describe("reviewQuery", () => {
  it("leaves empty filters out", () => { expect(reviewQuery({})).toBe(""); expect(reviewQuery({ table: "", rating: "", maxRating: "" })).toBe(""); });
  it("maps every filter to the API names", () => {
    expect(reviewQuery({ table: "general", rating: 5, from: "2026-11-01", to: "2026-11-02", limit: 50, offset: 100 }))
      .toBe("?table=general&rating=5&date_from=2026-11-01&date_to=2026-11-02&limit=50&offset=100");
    expect(reviewQuery({ maxRating: 2 })).toBe("?max_rating=2");
  });
});

describe("reviewCsvRows", () => {
  it("has a header row and names the restaurant-wide QR", () => {
    const rows = reviewCsvRows([rv({}), rv({ table_id: null, table_label: null, rating: 1, comment: "cold", guest_name: "Asha", guest_contact: "+919876543210" })], () => "2 Nov 2026, 1:30 pm");
    expect(rows[0]).toEqual(["Date and time", "Table", "Rating", "Comment", "Guest name", "Guest phone or email"]);
    expect(rows[2]).toEqual(["2 Nov 2026, 1:30 pm", "Restaurant-wide QR", 1, "cold", "Asha", "+919876543210"]);
  });
  it("guest text cannot become a spreadsheet formula (the existing csv.ts guard)", () => {
    const csv = toCsv(reviewCsvRows([rv({ comment: "=HYPERLINK(\"http://x\")", guest_name: "+cmd", guest_contact: " @SUM(1)" })], () => "t"));
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(csv).toContain("'+cmd");
    expect(csv).toContain("' @SUM(1)");
  });
});

describe("file names and stars", () => {
  it("makes safe file names", () => {
    expect(fileSafe(" Patio 2/A ")).toBe("patio-2-a");
    expect(fileSafe("***")).toBe("qr");
    expect(qrFileName("menu", "T1", "png")).toBe("menu-qr-table-t1.png");
    expect(qrFileName("review", null, "pdf")).toBe("review-qr-restaurant.pdf");
  });
  it("draws 0-5 stars", () => { expect(stars(4)).toBe("★★★★☆"); expect(stars(9)).toBe("★★★★★"); expect(stars(-1)).toBe("☆☆☆☆☆"); });
});
