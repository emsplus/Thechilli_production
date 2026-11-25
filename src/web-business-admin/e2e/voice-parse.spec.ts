import { expect, test } from "@playwright/test";
import { buildVoiceMenu, normalizePhone, parseOrder, wordSim, type ParsedOrder } from "../src/lib/voiceParse";
import type { Category, DiningTable, MenuItem } from "../src/lib/types";
import { KARAHI_MENU } from "./fixtures/karahi-menu";

/** Pure-module specs (no browser) for the on-device voice order parser, against The Karahi's real 219-dish menu. */

const cats: Category[] = KARAHI_MENU.map(([name], i) => ({ id: `c${i}`, name, sort_order: i }) as unknown as Category);
const items: MenuItem[] = KARAHI_MENU.flatMap(([, dishes], ci) => dishes.map(([name, opts], k) => ({
  id: `${ci}-${k}`, category_id: `c${ci}`, name, price: "1.00", is_active: true,
  variants: (opts ?? []).map((o, j) => ({ id: `${ci}-${k}-v${j}`, name: o, price_delta: "1.00" })),
})));
const byId = new Map(items.map((i) => [i.id, i]));
const menu = buildVoiceMenu(items, cats);
/** The Karahi's floor: T1-T10 inside, O1-O10 outside (ids "T3" / "O2" = the label). */
const tables: DiningTable[] = [
  ...Array.from({ length: 10 }, (_, i) => ({ id: `T${i + 1}`, label: `T${i + 1}`, seats: 4, area: "indoor" as const })),
  ...Array.from({ length: 10 }, (_, i) => ({ id: `O${i + 1}`, label: `O${i + 1}`, seats: 4, area: "outdoor" as const })),
];
const catOf = (id: string) => cats.find((c) => c.id === byId.get(id)!.category_id)!.name;

const parse = (text: string) => parseOrder(text, menu, { tables });
/** "2x Karahi Lamb / Jug" per line, the way staff would read the sheet. */
function lines(r: ParsedOrder): string[] {
  return r.lines.map((l) => {
    const it = byId.get(l.itemId)!;
    const v = it.variants.find((x) => x.id === l.variantId);
    return `${l.qty}x ${it.name}${v ? ` / ${v.name}` : ""}`;
  });
}
const L = (text: string) => lines(parse(text));

test("English and Hindi/Punjabi number words, digits and x2", () => {
  expect(L("two lamb karahi, one garlic naan")).toEqual(["2x Karahi Lamb", "1x Garlic Naan"]);
  expect(L("2 lamb karahi 1 garlic naan 3 pilau rice")).toEqual(["2x Karahi Lamb", "1x Garlic Naan", "3x Pilau Rice"]);
  expect(L("do butter naan ek daal makhani teen mango lassi")).toEqual(["2x Butter Naan", "1x Daal Makhani", "3x Mango Lassi"]);
  expect(L("char roti, paanch chapatti, chhe gulab jamun, saat onion bhaji, aath pappad, nau coke, das plain rice"))
    .toEqual(["4x Roti", "5x Chapatti", "6x Gulab Jamun", "7x Onion Bhaji", "8x Pappad", "9x Coke", "10x Plain Rice"]);
  expect(L("chicken tikka x2, butter naan x 3, jeera rice 2x")).toEqual(["2x Chicken Tikka", "3x Butter Naan", "2x Jeera Rice"]);
  expect(L("twenty one butter naan")).toEqual(["21x Butter Naan"]);
  expect(L("lamb biryani 2")).toEqual(["2x Lamb Biryani"]); // a number after the dish, at the end
  expect(L("ek aur garlic naan")).toEqual(["1x Garlic Naan"]); // "one more"
  expect(L("ek garlic naan de do")).toEqual(["1x Garlic Naan"]); // "de do" = give, not 2
  expect(L("a butter chicken and a coke please")).toEqual(["1x Butter Chicken", "1x Coke"]);
  // a quantity in one speech segment and the dish in the next
  expect(L("two, lamb karahi")).toEqual(["2x Karahi Lamb"]);
  const homo = parse("to garlic naan");
  expect(lines(homo)).toEqual(["2x Garlic Naan"]);
  expect(homo.lines[0].issues.join()).toContain("check the quantity");
});

test("options: jug, large, 50ml, full, half pint and unknown sizes", () => {
  expect(L("mango lassi jug, 2 sweet lassi jug")).toEqual(["1x Mango Lassi / Jug", "2x Sweet Lassi / Jug"]);
  expect(L("a large panjabi salad")).toEqual(["1x Panjabi Salad / Large"]);
  expect(L("ek gin 50 ml, 2 vodka 50ml, whisky")).toEqual(["1x Gin / 50ml", "2x Vodka / 50ml", "1x Whisky"]);
  expect(L("full tandoori chicken, half tandoori chicken")).toEqual(["1x Tandoor Chicken / Full", "1x Tandoor Chicken"]);
  expect(L("2 draught beer half pint and a draught beer pint")).toEqual(["2x Draught Beer (Half Pint)", "1x Draught Beer (Pint)"]);
  expect(L("kebab roll large, kebab roll regular")).toEqual(["1x Kebab Roll Large (3 pcs)", "1x Kebab Roll Regular (2 pcs)"]);
  expect(L("coke bottle, diet coke")).toEqual(["1x Coke (Bottle)", "1x Diet Coke"]);
  expect(L("lime soda jug")).toEqual(["1x Lime Soda / Jug"]);
  const big = parse("large butter naan");
  expect(lines(big)).toEqual(["1x Butter Naan"]);
  expect(big.lines[0].issues).toEqual(["option “large” not on the menu: regular chosen"]);
});

test("fuzzy dish names: Hinglish spellings, word order, recogniser slips; fillers ignored", () => {
  expect(L("kadai paneer")).toEqual(["1x Karahi Paneer"]);
  expect(L("chicken karahi")).toEqual(["1x Karahi Chicken"]);
  expect(L("pulao rice, dal makhni, chana masala, lamb rogan gosh")).toEqual(["1x Pilau Rice", "1x Daal Makhani", "1x Channa Masala", "1x Lamb Rogan Josh"]);
  expect(L("punjabi butter chicken")).toEqual(["1x Panjabi Butter Chicken"]);
  expect(L("chicken biriyani, prawns biryani")).toEqual(["1x Chicken Biryani", "1x Prawn Biryani"]);
  expect(L("seek kebab, peshawari naan, lachha paratha")).toEqual(["1x Seekh Kebab (2 pcs)", "1x Peshwari Naan", "1x Lacha Paratha"]);
  expect(L("i would like two of the chicken tikka masala please")).toEqual(["2x Chicken Tikka Masala"]);
  expect(L("7 up and a red bull")).toEqual(["1x 7UP", "1x Red Bull"]);
  expect(L("apple and mango")).toEqual(["1x Apple & Mango"]); // "and" inside a dish name is not a split
  expect(L("ras malai, malai kofta")).toEqual(["1x Ras Malai", "1x Malai Kofta"]);
  expect(L("garlic nan, butter rotti")).toEqual(["1x Garlic Naan", "1x Butter Roti"]);
  expect(L("chicken jalfrazi")).toEqual(["1x Chicken Jalfrezi"]);
  expect(L("okay thank you that's all")).toEqual([]);
  expect(parse("okay thank you that's all").unmatched).toEqual([]);
});

test("ambiguous and unsure lines are flagged with alternatives; nonsense goes to not matched", () => {
  const twin = parse("chilli chicken");
  expect(twin.lines).toHaveLength(1);
  expect(twin.lines[0].issues[0]).toMatch(/dishes fit/);
  expect(twin.lines[0].alternatives).toHaveLength(1);
  expect(byId.get(twin.lines[0].alternatives[0])!.name).toBe("Chilli Chicken");
  // the section settles it
  const starter = parse("chilli chicken starter");
  expect(catOf(starter.lines[0].itemId)).toBe("Non Veg Starters");
  expect(starter.lines[0].issues).toEqual([]);
  expect(catOf(parse("chilli chicken main").lines[0].itemId)).toBe("Non Veg Mains");

  const lassi = parse("lassi");
  expect(lassi.lines[0].issues.length).toBeGreaterThan(0);
  expect(lassi.lines[0].alternatives.map((id) => byId.get(id)!.name).sort()).toEqual(expect.arrayContaining(["Salty Lassi", "Sweet Lassi"]));
  expect(parse("chicken tikka").lines[0].issues).toEqual([]); // an exact name is sure even though longer names contain it

  const odd = parse("two lamb karahi, one pizza special, 3 garlic naan");
  expect(lines(odd)).toEqual(["2x Karahi Lamb", "3x Garlic Naan"]);
  expect(odd.unmatched.map((u) => u.text)).toEqual(["one pizza special"]);
  expect(parse("ek pizza margherita").lines.map((l) => byId.get(l.itemId)!.name)).not.toContain("Karahi Lamb");
  expect(parse("biscuits").unmatched.map((u) => u.text)).toEqual(["biscuits"]);
});

test("notes are kept apart from the dish", () => {
  const r = parse("2 lamb karahi extra spicy, butter chicken no onion");
  expect(lines(r)).toEqual(["2x Karahi Lamb", "1x Butter Chicken"]);
  expect(r.lines.map((l) => l.note)).toEqual(["extra spicy", "no onion"]);
});

test("customer name and phone (Indian formats, normalised like the server)", () => {
  let r = parse("two lamb karahi, customer name Raj, number 098765 00123");
  expect(r.name).toBe("Raj");
  expect(r.phone).toBe("+919876500123");
  expect(r.phoneHeard).toBe("098765 00123");
  expect(lines(r)).toEqual(["2x Karahi Lamb"]);

  r = parse("customer ka naam Raj Kumar hai, phone number zero nine eight seven six five double zero one two three, do naan");
  expect(r.name).toBe("Raj Kumar");
  expect(r.phone).toBe("+919876500123");
  expect(lines(r)).toEqual(["2x Naan"]);
  expect(parse("naam priya mobile +91 22 4000 1234").phone).toBe("+912240001234");
  expect(parse("number 022 4000 1234 two naan").phone).toBe("+912240001234");
  expect(lines(parse("number 022 4000 1234 two naan"))).toEqual(["2x Naan"]);
  expect(parse("customer phone 0091 98765 00123").phone).toBe("+919876500123");
  expect(parse("naam Priya").name).toBe("Priya");
  // a number that is too short is kept as heard for the user to fix
  r = parse("customer number 770 1234");
  expect(r.phone).toBeNull();
  expect(r.phoneHeard).toBe("770 1234");
  // India (the default): +91, with or without the leading 0, digits or words
  expect(parseOrder("customer Raj number 98765 43210", menu, { tables }).phone).toBe("+919876543210");
  expect(parseOrder("number 098765 43210 two naan", menu, { tables }).phone).toBe("+919876543210");
  expect(parseOrder("phone nine eight seven six five four three two one zero", menu, { tables }).phone).toBe("+919876543210");
  expect(normalizePhone("+91 98765 43210")).toBe("+919876543210");
  expect(normalizePhone("09876543210")).toBe("+919876543210");
  expect(normalizePhone("9876543210")).toBe("+919876543210");
  expect(normalizePhone("+91 (0)22 4000 1234")).toBe("+912240001234");
  expect(normalizePhone("12")).toBeNull();
  // a long number without a cue word is still a phone number; short numbers are quantities
  expect(parse("2 naan 09876500123").phone).toBe("+919876500123");
  expect(parse("2 naan").phone).toBeNull();
  // "customer" followed by an order is not a name
  expect(parse("customer wants two naan").name).toBeNull();
});

test("takeaway / delivery / dine-in words and tables", () => {
  expect(parse("2 naan takeaway").type).toBe("takeaway");
  expect(parse("take away please, 2 naan").type).toBe("takeaway");
  expect(parse("collection, ek lassi").type).toBe("takeaway");
  expect(parse("parcel kar do, 2 roti").type).toBe("takeaway");
  expect(parse("home delivery, 2 naan").type).toBe("delivery");
  expect(parse("eat in").type).toBe("indoor");
  expect(parse("2 naan").type).toBeNull();
  let r = parse("table 5, two lamb karahi");
  expect([r.tableId, r.tableLabel, r.type, r.needsTable]).toEqual(["T5", "T5", "indoor", false]);
  expect(lines(r)).toEqual(["2x Karahi Lamb"]);
  r = parse("table number t1 ek coke");
  expect([r.tableId, r.type]).toEqual(["T1", "indoor"]);
  expect(lines(r)).toEqual(["1x Coke"]);
  r = parse("table 99 do naan");
  expect([r.tableId, r.tableLabel, r.type, r.needsTable]).toEqual([null, "Table 99", "indoor", true]);
  expect(lines(r)).toEqual(["2x Naan"]);
});

test("dine-in / outdoor / andar / bahar with a table: type AND table, area follows the table", () => {
  const t = (s: string) => { const r = parse(s); return [r.type, r.tableId, r.needsTable]; };
  expect(t("dine in table 5")).toEqual(["indoor", "T5", false]);
  expect(t("dine in table T3")).toEqual(["indoor", "T3", false]);
  expect(t("dine in t 3")).toEqual(["indoor", "T3", false]);
  expect(t("dine in table number ten")).toEqual(["indoor", "T10", false]);
  expect(t("eat in table 7")).toEqual(["indoor", "T7", false]);
  expect(t("outdoor O2")).toEqual(["outdoor", "O2", false]);
  expect(t("outdoor table o 4")).toEqual(["outdoor", "O4", false]);
  expect(t("outdoor table 3")).toEqual(["outdoor", "O3", false]); // a bare number means the outdoor table when "outdoor" was said
  expect(t("outside table 6")).toEqual(["outdoor", "O6", false]);
  expect(t("table O7")).toEqual(["outdoor", "O7", false]); // no type word: the table decides
  expect(t("table T10")).toEqual(["indoor", "T10", false]);
  expect(t("dine in table O2")).toEqual(["outdoor", "O2", false]); // the table's area wins over "dine in"
  expect(t("bahar table 2")).toEqual(["outdoor", "O2", false]);
  expect(t("bahar O5")).toEqual(["outdoor", "O5", false]);
  expect(t("andar table 4")).toEqual(["indoor", "T4", false]);
  expect(t("andar t8")).toEqual(["indoor", "T8", false]);
  expect(t("table paanch")).toEqual(["indoor", "T5", false]);
  // dine-in without a table: the type stays, the sheet is told a table is needed
  expect(t("dine in")).toEqual(["indoor", null, true]);
  expect(t("andar baithenge")).toEqual(["indoor", null, true]);
  expect(t("outdoor")).toEqual(["outdoor", null, true]);
  expect(t("bahar")).toEqual(["outdoor", null, true]);
  expect(t("takeaway")).toEqual(["takeaway", null, false]);
  expect(t("delivery")).toEqual(["delivery", null, false]);
  expect(t("takeaway table 5")).toEqual(["takeaway", null, false]); // no table on a takeaway
  expect(t("dine in table 55")).toEqual(["indoor", null, true]); // unknown table: kept as heard, must be chosen
  expect(parse("dine in table 55").tableLabel).toBe("Table 55");
  expect(parse("2 naan").needsTable).toBe(false);
});

test("one sentence: type + table + name + number + items", () => {
  let r = parse("dine in table 5 customer name Raj number 098765 00123 do lamb karahi ek garlic naan teen mango lassi jug");
  expect([r.type, r.tableId, r.name, r.phone]).toEqual(["indoor", "T5", "Raj", "+919876500123"]);
  expect(lines(r)).toEqual(["2x Karahi Lamb", "1x Garlic Naan", "3x Mango Lassi / Jug"]);
  r = parse("outdoor O2, naam Priya, phone 098765 00124, do butter naan aur ek daal makhani");
  expect([r.type, r.tableId, r.name, r.phone]).toEqual(["outdoor", "O2", "Priya", "+919876500124"]);
  expect(lines(r)).toEqual(["2x Butter Naan", "1x Daal Makhani"]);
  r = parse("do garlic naan, ek coke, bahar table 7, customer ka naam Amit");
  expect([r.type, r.tableId, r.name]).toEqual(["outdoor", "O7", "Amit"]);
  expect(lines(r)).toEqual(["2x Garlic Naan", "1x Coke"]);
  r = parse("takeaway, customer name Sam, number 022 4000 1234, 2 lamb biryani");
  expect([r.type, r.tableId, r.name, r.phone]).toEqual(["takeaway", null, "Sam", "+912240001234"]);
  expect(lines(r)).toEqual(["2x Lamb Biryani"]);
  r = parse("delivery 2 lamb biryani number 098765 00123 customer name Sam");
  expect([r.type, r.name]).toEqual(["delivery", "Sam"]);
  r = parse("andar table 3, char roti, ek dahi raita");
  expect([r.type, r.tableId]).toEqual(["indoor", "T3"]);
  expect(lines(r)).toEqual(["4x Roti", "1x Dahi Raita"]);
});

test("bill number: English and Hinglish, anywhere in the sentence, no false positives", () => {
  const b = (text: string) => { const r = parse(text); return [r.billNo, r.newBill]; };
  expect(b("bill number 2, 2 chicken tikka masala, 1 garlic naan, dine in table 5, name Raj")).toEqual([2, false]);
  expect(b("bill no 3 do naan")).toEqual([3, false]);
  expect(b("bill no. 4 do naan")).toEqual([4, false]);
  expect(b("bill 7 ek coke")).toEqual([7, false]);
  expect(b("bill nambar do, ek coke")).toEqual([2, false]);
  expect(b("bill number teen char roti")).toEqual([3, false]);
  expect(b("bill number paanch")).toEqual([5, false]);
  expect(b("bill number ek, do naan")).toEqual([1, false]);
  expect(b("bill number twelve ek coke")).toEqual([12, false]);
  expect(b("bill number twenty one ek coke")).toEqual([21, false]);
  expect(b("bill number to ek coke")).toEqual([2, false]); // "to" heard for two, after a cue word
  expect(b("2 garlic naan bill number 3")).toEqual([3, false]); // at the end
  expect(b("ek coke, bill number chhe, customer name Raj")).toEqual([6, false]); // in the middle
  expect(b("second bill, ek coke")).toEqual([2, false]);
  expect(b("doosra bill do naan")).toEqual([2, false]);
  expect(b("pehla bill ek coke")).toEqual([1, false]);
  expect(b("teesra bill ek coke")).toEqual([3, false]);
  expect(b("new bill, 2 naan")).toEqual([null, true]);
  expect(b("next bill 2 naan")).toEqual([null, true]);
  expect(b("naya bill do naan")).toEqual([null, true]);
  expect(b("agla bill do naan")).toEqual([null, true]);
  expect(b("bill number 2 actually bill number 3, ek coke")).toEqual([3, false]); // corrected while speaking: the last one wins
  expect(b("new bill, no sorry bill number 2")).toEqual([2, false]);
  expect(b("bill number 2 new bill")).toEqual([null, true]);
  // the rest of the order is unaffected
  const r = parse("bill number 2, 2 chicken tikka masala, 1 garlic naan, dine in table 5, customer name Raj number 098765 00123");
  expect(lines(r)).toEqual(["2x Chicken Tikka Masala", "1x Garlic Naan"]);
  expect([r.type, r.tableId, r.name, r.phone, r.billNo]).toEqual(["indoor", "T5", "Raj", "+919876500123", 2]);
  expect(r.unmatched).toEqual([]);
  expect(lines(parse("bill number 3 do naan"))).toEqual(["2x Naan"]); // the 3 is the bill, the 2 the quantity
  expect(lines(parse("bill 3 3 naan"))).toEqual(["3x Naan"]);
  // not a bill: no number, tables, quantities, phone digits, "bill" as a plain word
  expect(b("table 5 two naan")).toEqual([null, false]);
  expect(b("table number 2 ek coke")).toEqual([null, false]);
  expect(b("2 naan 3 coke")).toEqual([null, false]);
  expect(b("customer number 098765 00123 bill")).toEqual([null, false]);
  expect(parse("customer number 098765 00123 bill").phone).toBe("+919876500123");
  expect(b("bill number 098765 00123")).toEqual([null, false]);
  expect(parse("bill number 098765 00123").phone).toBe("+919876500123"); // a phone after "bill number" is still a phone
  expect(b("bill please")).toEqual([null, false]);
  expect(parse("bill please").unmatched).toEqual([]);
  expect(b("bill number 0 ek coke")).toEqual([null, false]);
  expect(b("bill number 100 ek coke")).toEqual([null, false]);
  expect(b("bill table 5")).toEqual([null, false]);
  expect(parse("bill table 5").tableId).toBe("T5");
  expect(b("ek naan next")).toEqual([null, false]);
  // table / bill numbers side by side keep their own meaning
  const t = parse("table number 3 bill number 5 ek coke");
  expect([t.tableId, t.billNo]).toEqual(["T3", 5]);
  const u = parse("bill number 5 table number 3 ek coke");
  expect([u.tableId, u.billNo]).toEqual(["T3", 5]);
});

test("a full spoken order (Chrome style: no punctuation) and stable keys while the transcript grows", () => {
  const said = "do lamb karahi ek garlic naan teen mango lassi jug customer name Raj number 098765 00123 takeaway";
  const r = parse(said);
  expect(lines(r)).toEqual(["2x Karahi Lamb", "1x Garlic Naan", "3x Mango Lassi / Jug"]);
  expect([r.name, r.phone, r.type]).toEqual(["Raj", "+919876500123", "takeaway"]);
  // the first line keeps its key as more speech arrives; lines still being spoken are marked pending
  const first = parseOrder("do lamb karahi, ek garlic", menu, { pendingFrom: "do lamb karahi".length });
  const later = parseOrder("do lamb karahi, ek garlic naan, teen roti", menu, {});
  expect(first.lines[0].key).toBe(later.lines[0].key);
  expect(first.lines[0].pending).toBe(false);
  expect(first.lines.at(-1)!.pending).toBe(true);
});

test("word similarity basics", () => {
  expect(wordSim("karahi", "karahi")).toBe(1);
  expect(wordSim("chilly", "chilli")).toBeGreaterThan(0.9);
  expect(wordSim("naan", "nan")).toBeGreaterThan(0.9);
  expect(wordSim("lamb", "lime")).toBe(0);
  expect(wordSim("paneer", "prawn")).toBe(0);
});

test("speed: a long order against 219 dishes parses in a few milliseconds", () => {
  const said = Array.from({ length: 8 }, () => "do lamb karahi ek garlic naan teen mango lassi jug chilli chicken starter").join(" ") + " customer name Raj number 098765 00123";
  const t = performance.now();
  for (let i = 0; i < 20; i++) parse(said);
  const per = (performance.now() - t) / 20;
  expect(per).toBeLessThan(50);
  console.log(`voiceParse: ${per.toFixed(2)} ms per parse of ${said.split(" ").length} words`);
});
