import { describe, expect, test } from "vitest";
import type { Category, MenuItem } from "./types";
import { buildVoiceMenu, parseOrder } from "./voiceParse";
import { detectCommand } from "./voiceCommands";
import { doneMenu, splitDone } from "./voiceDone";
import { stripWakes } from "./wakeWord";

// The owner's restaurant (docs/VOICE_QA_REPORT.md): Matar Paneer, Sweet Lassi, Mango Lassi, Tandoori Roti; taught aliases
// lassi -> Sweet Lassi, chapati -> Tandoori Roti. Plus the dishes the QA soak uses (sizes, an ambiguous biryani, a sold-out rice).
const cats: Category[] = [{ id: "c1", name: "Mains" }, { id: "c2", name: "Drinks" }, { id: "c3", name: "Breads" }, { id: "c4", name: "Rice" }] as Category[];
const item = (id: string, category_id: string, name: string, variants: { id: string; name: string; price_delta: string }[] = []): MenuItem =>
  ({ id, category_id, name, price: "100.00", is_active: true, variants } as unknown as MenuItem);
const items: MenuItem[] = [
  item("mp", "c1", "Matar Paneer"), item("sl", "c2", "Sweet Lassi"), item("ml", "c2", "Mango Lassi"), item("tr", "c3", "Tandoori Roti"),
  item("bc", "c1", "Butter Chicken", [{ id: "bch", name: "Half", price_delta: "0.00" }, { id: "bcf", name: "Full", price_delta: "180.00" }]),
  item("dm", "c1", "Dal Makhani"), item("gn", "c3", "Garlic Naan"), item("cb", "c4", "Chicken Biryani"), item("mb", "c4", "Mutton Biryani"), item("jr", "c4", "Jeera Rice"),
];
const vmenu = buildVoiceMenu(items, cats, [
  { phrase: "lassi", menu_item_id: "sl", variant_id: null },
  { phrase: "chapati", menu_item_id: "tr", variant_id: null },
] as never);
const dm = doneMenu(vmenu);

/** The sheet's order of operations (VoiceOrder.tsx splitCommand): done words first, then the command. */
function split(text: string) {
  const d = splitDone(text, dm);
  const c = detectCommand(d.rest, vmenu);
  return { command: c.command, done: d.done, rest: c.command ? splitDone(c.rest, dm).rest : d.rest };
}

describe("hypothesis (c): the spoken commands with trailing words, punctuation, capitals, Hinglish", () => {
  test.each([
    ["place order", "place"], ["Place order.", "place"], ["PLACE ORDER!", "place"], ["place the order", "place"], ["order place karo", "place"],
    ["order kar do", "place"], ["place order please", "place"], ["order place kar do", "place"], ["Order place kar do.", "place"], ["confirm order", "place"],
    ["place order ji", "place"], ["place order now", "place"],
    ["send to kitchen", "kot"], ["Send to kitchen.", "kot"], ["kitchen bhejo", "kot"], ["kitchen mein bhej do", "kot"], ["send KOT", "kot"], ["KOT bhejo", "kot"],
    ["send it to the kitchen", "kot"], ["place order and send to kitchen", "kot"],
  ])("%s -> %s", (text, cmd) => {
    expect(split(text).command).toBe(cmd);
    expect(split(`one matar paneer, two lassi, ${text}`).command).toBe(cmd);
    expect(split(`one matar paneer, two lassi, ${text}`).rest).toBe("one matar paneer, two lassi");
  });
});

describe("the soak's phrase pool parses to the dishes the soak expects", () => {
  const lines = (t: string) => parseOrder(t, vmenu).lines.map((l) => `${l.ask ? "?" : ""}${l.itemId}x${l.qty}`);
  test.each([
    ["one matar paneer, two lassi, four chapati", ["mpx1", "slx2", "trx4"]],
    ["One Matar Paneer. Two Lassi. Four Chapati.", ["mpx1", "slx2", "trx4"]],
    ["ek matar paneer, do lassi", ["mpx1", "slx2"]],
    ["three mango lassi", ["mlx3"]],
    ["two tandoori roti", ["trx2"]],
    ["one butter chicken full", ["bcx1"]],
    ["two dal makhani", ["dmx2"]],
    ["one biryani", ["?mbx1"]], // ask: Chicken or Mutton Biryani
    ["one jeera rice", ["jrx1"]],
  ])("%s", (t, want) => { expect(lines(t)).toEqual(want); });
});

describe("hypothesis (d): 'Hey Zonov' said again while the sheet is open is no dish", () => {
  test.each([
    ["one matar paneer, hey zonov, two lassi", "one matar paneer, two lassi"],
    ["one matar paneer, Hey Zonov", "one matar paneer"],
    ["hey zonov hey zonov one matar paneer", "one matar paneer"],
    ["one matar paneer", "one matar paneer"],
  ])("%j -> %j", (t, want) => {
    expect(stripWakes(t)).toBe(want);
    expect(parseOrder(stripWakes(t), vmenu).unmatched).toEqual([]);
  });
});
