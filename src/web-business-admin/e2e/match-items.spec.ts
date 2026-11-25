import { expect, test } from "@playwright/test";
import { dateWarning, duplicateGroups, looksLikeConsumable, normaliseGstin, sumQty } from "../src/lib/invoiceHints";
import { cleanItemName, inferBaseUnit, proposeBaseUnit, nameTokens, normalizedName, parsePack, similarity, suggestItem, MATCH_THRESHOLD } from "../src/lib/matchItems";
import { convertPack } from "../src/lib/packConvert";
import { divDecimal } from "../src/lib/decimal";
import { parseCsv, parseNumber, parseStockSheet, toBulkItems } from "../src/lib/stockCsv";

/** Pure-module specs (no browser): the invoice matcher, pack parsing and exact pack maths, the CSV parser. */

const inv = (...names: string[]) => names.map((name, i) => ({ id: String(i), name }));

test("cleanItemName drops sizes, packaging and trailing quantities, then Title Cases", () => {
  expect(cleanItemName("BASMATI RICE 20kg bag")).toBe("Basmati Rice");
  expect(cleanItemName("Chicken Breast Fillet 10kg")).toBe("Chicken Breast Fillet");
  expect(cleanItemName("Whole Milk 4 pint x 6")).toBe("Whole Milk");
  expect(cleanItemName("Eggs Large tray 30")).toBe("Eggs Large");
  expect(cleanItemName("Cooking Oil 20L")).toBe("Cooking Oil");
  expect(cleanItemName("Onions 25kg sack")).toBe("Onions");
  expect(cleanItemName("Fresh Coriander bunch")).toBe("Fresh Coriander");
  expect(cleanItemName("Paneer 1kg x 5")).toBe("Paneer");
  expect(cleanItemName("  Plain   flour   25kg  ")).toBe("Plain Flour");
  expect(cleanItemName("Tomatoes (box of 6kg)")).toBe("Tomatoes");
  expect(cleanItemName("5/7oz TILAPIA FILLETS SKINLESS BONELESS- GRADE 1 Br LORDS CHOICE")).toBe("5/7oz Tilapia Fillets Skinless Boneless- Grade");
  expect(cleanItemName("KTC RAPESEED OIL PLASTIC BOTTLES")).toBe("Ktc Rapeseed Oil Plastic Bottles");
  expect(cleanItemName("TS COCONUT MILK 99p")).toBe("Ts Coconut Milk");
  expect(cleanItemName("LEO KESTREL BLUE CARRIER BAGS 11x17x21")).toBe("Leo Kestrel Blue Carrier Bags 11x17x21");
  expect(cleanItemName("Bio Continental Yoghurt (1*9.5KG)")).toBe("Bio Continental Yoghurt");
  expect(cleanItemName("Budweiser Beer Bottles 12x660ml")).toBe("Budweiser Beer Bottles");
  expect(cleanItemName("12 x 1L")).toBe("12 X 1L"); // nothing sensible left: keeps the text rather than inventing a name
});

test("tokens ignore sizes, units, packaging, filler words and plurals", () => {
  expect(nameTokens("Fresh Chicken Breasts 10 kg bag")).toEqual(["chicken", "breast"]);
  expect(nameTokens("Tomatoes")).toEqual(["tomato"]);
  expect(nameTokens("Chilli Peppers & Onions")).toEqual(["chilli", "pepper", "onion"]);
  expect(normalizedName("Breast, Chicken")).toBe(normalizedName("chicken breast"));
});

test("suggestItem: exact normalised match wins, similar names pass the threshold, unrelated ones do not", () => {
  const items = inv("Chicken Breast", "Whole Milk", "Basmati Rice", "Eggs", "Onions", "Coconut Milk", "Cooking Oil");
  const s = (d: string) => suggestItem(d, items);
  expect(s("Chicken Breast Fillet 10kg")?.item.name).toBe("Chicken Breast");
  expect(s("CHICKEN BREASTS")?.exact).toBe(true);
  expect(s("Milk")?.item.name).toBe("Whole Milk"); // "whole" is filler, so these are the same ingredient
  expect(s("Whole Milk 4 pint x 6")?.exact).toBe(true);
  expect(s("Eggs Large tray 30")?.item.name).toBe("Eggs");
  expect(s("Fresh Onion 25kg sack")?.item.name).toBe("Onions");
  expect(s("Cooking Oil 20L")?.exact).toBe(true);
  expect(s("Premium Basmati Rice 20kg")?.item.name).toBe("Basmati Rice");
  expect(s("Paneer 1kg x 5")).toBeNull();
  expect(s("Rice flour 5kg")).toBeNull(); // shares one word out of two: below the threshold
  expect(s("")).toBeNull();
  expect(MATCH_THRESHOLD).toBe(0.6);
});

test("suggestItem prefers an exact match over a closer-looking partial one and is deterministic", () => {
  const items = inv("Chicken Breast Fillet", "Chicken Breast");
  expect(suggestItem("Chicken Breast 5kg", items)?.item.name).toBe("Chicken Breast");
  expect(suggestItem("Chicken Breast 5kg", [...items].reverse())?.item.name).toBe("Chicken Breast");
  expect(suggestItem("Chicken Breast Fillet", items)?.item.name).toBe("Chicken Breast Fillet");
  const tie = inv("Red Onion", "Brown Onion");
  expect(suggestItem("Onion", tie, 0.4)?.item.name).toBe("Red Onion"); // equal score: shorter name first, then A-Z, so "Red Onion" (9) beats "Brown Onion" (11)
  expect(similarity("Basmati Rice", "Basmati Rice 20kg")).toBe(1);
});

test("parsePack reads the usual invoice patterns", () => {
  expect(parsePack("Basmati Rice 20kg bag")).toEqual({ quantity: "20", unit: "kg" });
  expect(parsePack("Cooking Oil 20L")).toEqual({ quantity: "20", unit: "l" });
  expect(parsePack("Cooking Oil 20 ltr")).toEqual({ quantity: "20", unit: "l" });
  expect(parsePack("Soft drink 12 x 1L")).toMatchObject({ quantity: "12", unit: "l", each: { count: 12, quantity: "1", unit: "l" } });
  expect(parsePack("Cola 6x330ml")).toMatchObject({ quantity: "1980", unit: "ml" });
  expect(parsePack("Whole Milk 4 pint x 6")).toMatchObject({ quantity: "13632", unit: "ml" });
  expect(parsePack("Paneer 1kg x 5")).toMatchObject({ quantity: "5", unit: "kg" });
  expect(parsePack("Paneer 1kg x 5", "5")).toMatchObject({ quantity: "1", unit: "kg" }); // quantity equals the count: each piece is 1 kg
  expect(parsePack("Eggs Large tray 30")).toEqual({ quantity: "30", unit: "pcs" });
  expect(parsePack("Eggs (30 eggs)")).toEqual({ quantity: "30", unit: "pcs" });
  expect(parsePack("Naan bread 30 pcs")).toEqual({ quantity: "30", unit: "pcs" });
  expect(parsePack("Flour 1.5kg")).toEqual({ quantity: "1.5", unit: "kg" });
  expect(parsePack("Fresh Coriander bunch")).toBeNull();
});

test("inferBaseUnit follows the invoice unit, then a pack size, else pcs", () => {
  expect(inferBaseUnit("kg")).toBe("g");
  expect(inferBaseUnit("g")).toBe("g");
  expect(inferBaseUnit("ltr")).toBe("ml");
  expect(inferBaseUnit("litre")).toBe("ml");
  expect(inferBaseUnit("ml")).toBe("ml");
  expect(inferBaseUnit("each")).toBe("pcs");
  expect(inferBaseUnit("dozen")).toBe("pcs");
  expect(inferBaseUnit("bag")).toBe("pcs");
  expect(inferBaseUnit("bag", "Basmati Rice 20kg bag")).toBe("g");
  expect(inferBaseUnit("tray", "Eggs tray 30")).toBe("pcs");
  expect(inferBaseUnit("each", "Cooking Oil 20L")).toBe("ml");
  expect(inferBaseUnit("pcs", "Paneer 1kg x 5")).toBe("g");
  expect(inferBaseUnit("pcs", "Naan 30 pcs")).toBe("pcs");
});

test("proposeBaseUnit: bottles of drink in pieces, other liquids by volume, with a reason", () => {
  const bud = { count_total: "12", unit_size: "66", unit_size_unit: "cl" };
  expect(proposeBaseUnit("l", "Budweiser Beer Bottles 12x660ml", bud)).toMatchObject({ unit: "pcs" });
  expect(proposeBaseUnit("case", "Corona Extra Beer Bottles 12x620ml", null).unit).toBe("pcs"); // uncertain line: still read from the description
  expect(proposeBaseUnit("l", "Cobra Beer 11 Gallons", { count_total: null, unit_size: "50", unit_size_unit: "L" }).unit).toBe("ml"); // a keg is volume
  expect(proposeBaseUnit("l", "LANCASHIRE UHT SINGLE CREAM", { count_total: "24", unit_size: "1", unit_size_unit: "L" }).unit).toBe("ml"); // not a drink in bottles
  expect(proposeBaseUnit("kg", "NATCO CHOPPED TOMATOES").unit).toBe("g");
  expect(proposeBaseUnit("pcs", "SALMON PORTIONS").unit).toBe("pcs");
  expect(proposeBaseUnit("l", "Pepsi 24 x 330ml cans", { count_total: "24" }).reason).toContain("24 bottles or cans");
});

test("invoice hints: supplier GSTINs, odd dates, packaging, duplicate lines", () => {
  expect(normaliseGstin("27 aapfu 0939 f1zv")).toBe("27AAPFU0939F1ZV");
  expect(normaliseGstin("29-ABCDE-1234-F1Z5")).toBe("29ABCDE1234F1Z5");
  expect(normaliseGstin("432367265")).toBe("432367265"); // a bare number is kept as printed: no prefix is ever added
  expect(normaliseGstin("")).toBeNull();
  const today = new Date(2026, 9, 25);
  expect(dateWarning("2026-10-09", today)).toBeNull();
  expect(dateWarning("2026-10-25", today)).toBeNull();
  expect(dateWarning("2026-11-02", today)).toContain("future");
  expect(dateWarning("2020-10-07", today)).toContain("days ago");
  expect(dateWarning("2026-08-20", today)).toContain("66 days ago");
  expect(dateWarning("2026-08-26", today)).toBeNull();
  expect(dateWarning("", today)).toBeNull();
  const food = [{ description: "Basmati Rice 20kg bag", vat_rate: "0" }, { description: "Onions", vat_rate: "0" }, { description: "LEO KESTREL BLUE CARRIER BAGS", vat_rate: "18" }];
  expect(looksLikeConsumable(food[2], food)).toBe(true);
  expect(looksLikeConsumable(food[0], food)).toBe(false); // a bag of rice is food
  expect(looksLikeConsumable({ description: "Gizmo", vat_rate: "18" }, food)).toBe(true); // 18% among nil-rated food
  expect(looksLikeConsumable({ description: "Gizmo", vat_rate: "0" }, food)).toBe(false);
  const lines = [{ description: "KTC TOMATO KETCHUP", quantity: "18", unit: "kg", unit_price: "0.8878", item_code: "2727081" }, { description: "x", quantity: "1", unit: "kg", unit_price: "1" },
    { description: "KTC TOMATO KETCHUP", quantity: "18", unit: "kg", unit_price: "0.8878", item_code: "2727081" }, { description: "KTC Tomato Ketchup", quantity: "2", unit: "kg", unit_price: "9" }];
  expect(duplicateGroups(lines)).toEqual([[0, 2]]);
  expect(sumQty(["18", "18.5", "0.25"])).toBe("36.75");
});

test("convertPack is decimal exact and keeps the line total", () => {
  expect(convertPack("2", "25", "kg", "76.00")).toEqual({ quantity: "50", unit: "kg", unit_price: "1.52", total: "76.00" });
  expect(convertPack("1", "30", "pcs", "4.99")).toEqual({ quantity: "30", unit: "pcs", unit_price: "0.1663", total: "4.99" });
  expect(convertPack("3", "1.5", "l", "10.00")).toEqual({ quantity: "4.5", unit: "l", unit_price: "2.2222", total: "10.00" });
  expect(convertPack("7", "20", "kg", "23.31")).toEqual({ quantity: "140", unit: "kg", unit_price: "0.1665", total: "23.31" });
  expect(convertPack("0.1", "0.2", "kg", "0.03")).toEqual({ quantity: "0.02", unit: "kg", unit_price: "1.5", total: "0.03" });
  expect(convertPack("2", "", "kg", "76.00")).toBeNull();
  expect(convertPack("2", "0", "kg", "76.00")).toBeNull();
  expect(convertPack("0", "5", "kg", "76.00")).toBeNull();
  expect(convertPack("2", "abc", "kg", "76.00")).toBeNull();
  expect(divDecimal("1", "3", 4)).toBe("0.3333");
  expect(divDecimal("2", "3", 4)).toBe("0.6667");
  expect(divDecimal("1", "0", 4)).toBeNull();
});

test("parseCsv handles quotes, BOM, CRLF, tabs and semicolons", () => {
  expect(parseCsv("﻿name,unit\r\n\"Rice, basmati\",kg\r\n\"He said \"\"hi\"\"\",g\r\n")).toEqual([["name", "unit"], ["Rice, basmati", "kg"], ['He said "hi"', "g"]]);
  expect(parseCsv("a\tb\tc\n1\t2\t3")).toEqual([["a", "b", "c"], ["1", "2", "3"]]);
  expect(parseCsv("a;b\n1;2")).toEqual([["a", "b"], ["1", "2"]]);
  expect(parseCsv("a,b\n\n,\n1,2")).toEqual([["a", "b"], ["1", "2"]]);
  expect(parseCsv("x,\"multi\nline\",y")).toEqual([["x", "multi\nline", "y"]]);
});

test("parseNumber accepts Indian formats and rupee prefixes, and refuses another currency", () => {
  expect(parseNumber("1,250.50")).toBe("1250.50");
  expect(parseNumber("1,25,000.50")).toBe("125000.50"); // lakh grouping
  expect(parseNumber("₹180")).toBe("180");
  expect(parseNumber("₹180/-")).toBe("180");
  for (const v of ["₹1,250.50", "Rs. 1,250.50", "Rs 1,250.50", "Rs1,250.50", "INR 1,250.50"]) expect(parseNumber(v), v).toBe("1250.50");
  for (const v of ["£1.80", "$1.80", "€1.80"]) expect(parseNumber(v), v).toBeNull();
  expect(parseNumber("INR 99")).toBe("99");
  expect(parseNumber(" 12 ")).toBe("12");
  expect(parseNumber("2,5")).toBe("2.5");
  expect(parseNumber(".5")).toBe("0.5");
  expect(parseNumber("abc")).toBeNull();
  expect(parseNumber("1.2.3")).toBeNull();
});

test("parseStockSheet: header detection, validation, duplicates, existing names, payload", () => {
  const text = "name,unit,opening_quantity,reorder_level,unit_cost\nBasmati Rice,kg,\"1,250.50\",100,₹185\nWhole Milk,L,24,12,1.10\nbasmati rice,kg,1,,\nEggs,dozen,2,1,\nSalt,bag,5,,\nOil,l,abc,,\n,kg,1,,\nCoriander,pcs,,10,\nFlour,kg,5,,";
  const sheet = parseStockSheet(text, ["flour"]);
  expect(sheet.hasHeader).toBe(true);
  const by = (n: string) => sheet.rows.find((r) => r.name.toLowerCase() === n.toLowerCase() && r.status !== "duplicate") ?? sheet.rows.find((r) => r.name.toLowerCase() === n.toLowerCase())!;
  expect(sheet.rows.map((r) => [r.row, r.status])).toEqual([[2, "ok"], [3, "ok"], [4, "duplicate"], [5, "ok"], [6, "error"], [7, "error"], [8, "error"], [9, "ok"], [10, "existing"]]);
  expect(by("Salt").errors[0]).toContain("bag");
  expect(by("Oil").errors[0]).toContain("abc");
  const items = toBulkItems(sheet.rows);
  expect(items).toEqual([
    { name: "Basmati Rice", base_unit: "g", reorder_level: "100000.000", opening_quantity: "1250.50", opening_unit: "kg", unit_cost: "185" },
    { name: "Whole Milk", base_unit: "ml", reorder_level: "12000.000", opening_quantity: "24", opening_unit: "l", unit_cost: "1.10" },
    { name: "Eggs", base_unit: "pcs", reorder_level: "12.000", opening_quantity: "2", opening_unit: "dozen" },
    { name: "Coriander", base_unit: "pcs", reorder_level: "10.000" },
  ]);
});

test("parseStockSheet works without a header, with Excel tab paste and reordered headers", () => {
  const a = parseStockSheet("Rice\tkg\t20\nOil\tl\t10");
  expect(a.hasHeader).toBe(false);
  expect(a.rows.map((r) => [r.name, r.unit, r.opening, r.status])).toEqual([["Rice", "kg", "20", "ok"], ["Oil", "l", "10", "ok"]]);
  const b = parseStockSheet("Unit,Item,Qty\nkg,Rice,20");
  expect(b.hasHeader).toBe(true);
  expect(b.rows[0]).toMatchObject({ name: "Rice", unit: "kg", opening: "20", status: "ok" });
  expect(parseStockSheet("").rows).toEqual([]);
});
