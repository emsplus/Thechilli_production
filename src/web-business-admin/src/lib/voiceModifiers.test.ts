import { describe, expect, test } from "vitest";
import type { Category, MenuItem } from "./types";
import { buildVoiceMenu, parseOrder } from "./voiceParse";
import { normalizeModifiers } from "./voiceModifiers";

// Spoken modifiers like a waiter hears them (owner, 2026-11-02; docs/VOICE_QA_REPORT.md B21).
const cats = [{ id: "c1", name: "Mains" }, { id: "c2", name: "Breads" }, { id: "c3", name: "Drinks" }] as Category[];
const items = [
  { id: "bc", category_id: "c1", name: "Butter Chicken", price: "280", is_active: true, variants: [{ id: "h", name: "Half", price_delta: "0" }, { id: "f", name: "Full", price_delta: "180" }] },
  { id: "dm", category_id: "c1", name: "Dal Makhani", price: "220", is_active: true, variants: [] },
  { id: "mp", category_id: "c1", name: "Matar Paneer", price: "240", is_active: true, variants: [] },
  { id: "pt", category_id: "c1", name: "Paneer Tikka", price: "260", is_active: true, variants: [] },
  { id: "bn", category_id: "c2", name: "Butter Naan", price: "50", is_active: true, variants: [] },
  { id: "gn", category_id: "c2", name: "Garlic Naan", price: "60", is_active: true, variants: [] },
  { id: "sl", category_id: "c3", name: "Sweet Lassi", price: "80", is_active: true, variants: [] },
] as unknown as MenuItem[];
const vm = buildVoiceMenu(items, cats, [{ phrase: "lassi", menu_item_id: "sl", variant_id: null }] as never);
const names = items.map((i) => i.name.toLowerCase());
/** As the sheet does it: modifiers first, then the parser. "item/variant xQty #note". */
const said = (t: string) => parseOrder(normalizeModifiers(t, { names }), vm, {}).lines.map((l) => `${l.itemId}${l.variantId ? `/${l.variantId}` : ""} x${l.qty}${l.note ? ` #${l.note.toLowerCase()}` : ""}`);

describe("modifiers go into the dish's note", () => {
  test.each([
    ["ek butter chicken full, butter kam dalna", ["bc/f x1 #less butter"]],
    ["one butter chicken full, less butter", ["bc/f x1 #less butter"]],
    ["one butter chicken full less butter", ["bc/f x1 #less butter"]],
    ["ek butter chicken, kam butter", ["bc/h x1 #less butter"]],
    ["ek dal makhani thoda kam teekha", ["dm x1 #less spicy"]],
    ["ek dal makhani, kam teekha", ["dm x1 #less spicy"]],
    ["ek dal makhani teekha kam karna", ["dm x1 #less spicy"]],
    ["one dal makhani no onion", ["dm x1 #no onion"]],
    ["one dal makhani, no onion", ["dm x1 #no onion"]],
    ["ek dal makhani bina pyaaz ke", ["dm x1 #no onion"]],
    ["ek dal makhani pyaaz nahi", ["dm x1 #no onion"]],
    ["ek dal makhani pyaz mat dalna", ["dm x1 #no onion"]],
    ["ek matar paneer bina lehsun", ["mp x1 #no garlic"]],
    ["ek matar paneer without garlic", ["mp x1 #no garlic"]],
    ["one matar paneer extra spicy", ["mp x1 #extra spicy"]],
    ["ek matar paneer zyada teekha", ["mp x1 #extra spicy"]],
    ["ek matar paneer teekha zyada", ["mp x1 #extra spicy"]],
    ["ek matar paneer mirchi zyada dalna", ["mp x1 #extra spicy"]],
    ["ek dal makhani zyada gravy", ["dm x1 #extra gravy"]],
    ["ek dal makhani extra butter", ["dm x1 #extra butter"]],
    ["ek dal makhani extra cheese", ["dm x1 #extra cheese"]],
    ["ek dal makhani tel kam", ["dm x1 #less oil"]],
    ["ek dal makhani namak kam", ["dm x1 #less salt"]],
    ["ek sweet lassi cheeni kam", ["sl x1 #less sugar"]],
    ["ek lassi meetha kam", ["sl x1 #less sweet"]],
    ["ek lassi bina baraf", ["sl x1 #no ice"]],
    ["ek matar paneer jain", ["mp x1 #jain"]],
    ["ek dal makhani mild", ["dm x1 #spicy"]],
    ["ek dal makhani alag se packing", ["dm x1 #separately"]],
    ["ek dal makhani, parcel alag", ["dm x1 #separately"]],
    ["एक दाल मखनी, प्याज़ नहीं", ["dm x1 #no onion"]],
    ["एक दाल मखनी बिना लहसुन", ["dm x1 #no garlic"]],
    ["एक मटर पनीर कम तीखा", ["mp x1 #less spicy"]],
    ["ek butter chicken half, butter kam, do garlic naan", ["bc/h x1 #less butter", "gn x2"]],
  ])("%j", (t, want) => {
    const got = said(t);
    expect(got.map((g) => g.split(" #")[0])).toEqual(want.map((w) => w.split(" #")[0]));
    // the note holds the modifier (the parser may word it its own way: "mild" -> "less spicy", "jain (no onion, no garlic)")
    want.forEach((w, k) => { if (w.includes(" #")) expect(got[k], t).toContain(w.split(" #")[1].split(" ").pop()!); });
  });
});

describe("a real dish after an ingredient word is never eaten", () => {
  test.each([
    ["do butter naan", ["bn x2"]],
    ["ek butter chicken, do butter naan", ["bc/h x1", "bn x2"]],
    ["ek extra butter naan", ["bn x1"]],
    ["ek garlic naan", ["gn x1"]],
    ["ek paneer tikka", ["pt x1"]],
    ["do butter naan aur ek garlic naan", ["bn x2", "gn x1"]],
    ["ek dal makhani, ek garlic naan", ["dm x1", "gn x1"]],
  ])("%j", (t, want) => { expect(said(t).map((x) => x.split(" #")[0])).toEqual(want); });
  test("no cue word: nothing changes", () => { expect(normalizeModifiers("ek butter chicken, butter naan", { names })).toBe("ek butter chicken, butter naan"); });
});
