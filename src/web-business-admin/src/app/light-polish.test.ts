import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** Owner approval 2026-11-03 (docs/testing/BREAK_UI_REPORT.md D07 + D22, docs/testing/LIGHT_POLISH_REPORT.md): the four near-black surfaces
 *  (#111820) are light now and the dimmed reservation cards use explicit muted colours. Source guards for exactly those surfaces. */
const read = (rel: string) => fs.readFileSync(path.resolve(import.meta.dirname, rel), "utf8");

describe("D07: no near-black surface left in a light-only product", () => {
  it("Manage > Tables: an in-use tile is a light Chilli tint with a red border and dark text, not ink", () => {
    const src = read("manage/_components/TablesTab.tsx");
    expect(src).toContain('occupied: { tile: "bg-primary-soft border-primary", badge: "warning" }');
    expect(src).toContain('kitchen: { tile: "bg-primary-soft border-primary", badge: "info" }');
    expect(src).toContain('free: { tile: "bg-surface border-border-strong", badge: "success" }'); // free tiles unchanged
    expect(src).not.toMatch(/bg-ink|border-ink|text-on-ink/);
  });
  it("counter: Card and UPI pay buttons are the standard outlined (secondary) button, Cash stays the red primary", () => {
    const src = read("pos/_components/OrderPanel.tsx");
    expect(src).not.toMatch(/variant="ink"|"ink"/);
    expect(src).toMatch(/<Button variant="secondary" size="pay"[^>]*>[^<]*<span className="sr-only">Pay <\/span>Card/);
    expect(src).toMatch(/<Button variant="secondary" size="pay"[^>]*>[^<]*<span className="sr-only">Pay <\/span>UPI/);
    expect(src).toMatch(/<Button variant="primary" size="pay"[^>]*>[^<]*<span className="sr-only">Pay <\/span>Cash/);
  });
  it("kitchen ticket: a light card (no data-kds dark palette); late = a red (danger) leading bar", () => {
    expect(read("kitchen/_components/KitchenTicket.tsx")).not.toContain(`data-kds=""`);
    const css = read("globals.css");
    expect(css).toContain('.ch-kds-ticket.kitchen-ticket[data-wait="late"] { border-inline-start: 5px solid var(--c-danger); }');
    expect(css).toContain('.ch-kds-ticket.kitchen-ticket[data-wait="warn"] { border-inline-start: 5px solid var(--c-warning); }');
    expect(css).not.toContain("--c-kds-");
  });
});

describe("D22: reservations no-show / cancelled cards are muted by colour, not by opacity", () => {
  const src = read("reservations/page.tsx");
  it("has no opacity-75 and marks inactive cards with explicit muted tokens", () => {
    expect(src).not.toMatch(/opacity-75["` ]/);
    expect(src).toContain('const off = r.status === "cancelled" || r.status === "no_show";');
    expect(src).toContain('off ? "bg-surface-3 text-fg-muted"');
    expect(src).toContain('off ? "text-fg-muted" : "text-fg"');
    expect(src).toContain('off ? "text-fg-muted underline" : "text-primary"');
  });
});
