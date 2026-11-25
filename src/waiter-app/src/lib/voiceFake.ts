import { searchItems } from "./aliases";
import { VoiceError, type VoiceClarificationDto, type VoiceLineDto, type VoiceOrderingProvider, type VoiceOrderResponse, type VoiceRequest } from "./voice";
import type { MenuItem } from "./types";

/** Deterministic stand-in for pos-service (NEXT_PUBLIC_VOICE_FAKE=1 and tests). Never calls the network. */
export const FAKE_TRANSCRIPT = "do masala chai aur ek paneer tikka";
const NUM: Record<string, number> = { ek: 1, one: 1, "एक": 1, do: 2, two: 2, "दो": 2, teen: 3, three: 3, "तीन": 3, char: 4, four: 4, "चार": 4, paanch: 5, panch: 5, five: 5, "पांच": 5 };

export function fakeParse(text: string, items: MenuItem[]): VoiceOrderResponse {
  const lines: VoiceLineDto[] = [], unmatched: string[] = [], clarifications: VoiceClarificationDto[] = [];
  const active = items.filter((i) => i.is_active);
  for (const raw of text.split(/,|\band\b|\baur\b|\bor\b|और/i).map((s) => s.trim()).filter(Boolean)) {
    const words = raw.split(/\s+/);
    const first = words[0].toLowerCase();
    const q = /^\d+$/.test(first) ? Number(first) : NUM[first];
    const name = (q !== undefined ? words.slice(1) : words).join(" ");
    const quantity = q ?? 1;
    const hits = name ? searchItems(active, name) : [];
    if (hits.length === 1 || (hits.length > 1 && hits[0].name.toLowerCase() === name.toLowerCase())) {
      lines.push({ item_id: hits[0].id, item_name: hits[0].name, variant_id: null, variant_name: null, quantity, note: null, heard_text: raw, confidence: 0.9, needs_review: false, issues: [] });
    } else if (hits.length > 1) {
      clarifications.push({ id: `fake${clarifications.length}`, heard_text: raw, quantity, options: hits.slice(0, 4).map((i) => ({ item_id: i.id, item_name: i.name, variant_id: null, variant_name: null })) });
    } else unmatched.push(raw);
  }
  return { transcript: text, lines, unmatched, clarifications };
}

export const fakeProvider: VoiceOrderingProvider = {
  isSupported: () => true,
  parse: (req: VoiceRequest, signal: AbortSignal) => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new VoiceError("aborted"));
    const t = setTimeout(() => resolve(fakeParse(req.text ?? FAKE_TRANSCRIPT, req.menu ?? [])), 250);
    signal.addEventListener("abort", () => { clearTimeout(t); reject(new VoiceError("aborted")); }, { once: true });
  }),
};
