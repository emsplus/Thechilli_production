import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// QA break-ui D21: a 120-character unbroken guest name / 400-character note ran out of the reservation card.
describe("reservation card wraps long text", () => {
  const src = readFileSync(join(__dirname, "page.tsx"), "utf8");
  it("name and notes break anywhere; the time chip never wraps", () => {
    expect(src).toContain('<span className="min-w-0 [overflow-wrap:anywhere]">{r.guest_name}</span>');
    expect(src).toContain('text-fg-muted [overflow-wrap:anywhere]">{r.notes}</p>');
    expect(src).toContain("shrink-0 place-items-center whitespace-nowrap");
  });
});
