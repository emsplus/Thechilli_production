import { describe, expect, it } from "vitest";
import { REPORT_MSG } from "./messages";

// The product labels Indian tax as GST everywhere: a bare "tax" in a visible report label must say GST (India only).
describe("report messages", () => {
  it("never show a bare 'tax' without GST in English, Hindi or Hinglish", () => {
    const bad = Object.entries(REPORT_MSG as Record<string, Record<string, string>>).flatMap(([k, v]) =>
      Object.entries(v).filter(([, text]) => /\btax\b|टैक्स/i.test(text) && !/GST|input tax|output tax|आउटपुट|इनपुट/i.test(text)).map(([lang, text]) => `${k}.${lang}: ${text}`));
    expect(bad).toEqual([]);
  });
});
