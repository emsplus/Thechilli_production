import { describe, expect, test } from "vitest";
import menuJson from "./__fixtures__/voice/demo_menu.json";
import corpusJson from "./__fixtures__/voice/voice_corpus.json";
import type { Category, MenuItem } from "./types";
import { buildVoiceMenu, parseOrder } from "./voiceParse";
import { detectCommand } from "./voiceCommands";
import { doneMenu, scrubDone, splitDone as split } from "./voiceDone";

const items = (menuJson as unknown as { items: MenuItem[] }).items;
const cats = (menuJson as unknown as { categories: Category[] }).categories;
const vmenu = buildVoiceMenu(items, cats);
const dm = doneMenu(vmenu);
/** The way the sheet calls it: with the menu (words + "is a dish understood"). */
const splitDone = (t: string, m: unknown = dm) => split(t, m as typeof dm);
const cases = (corpusJson as unknown as { cases: { id: string; cat: string; text: string }[] }).cases;

describe("splitDone: the words that end an order", () => {
  test.each([
    ["done", ""],
    ["Done.", ""],
    ["done!", ""],
    ["DONE", ""],
    ["ok done", ""],
    ["okay done", ""],
    ["Okay, done.", ""],
    ["done karo", ""],
    ["done kar do", ""],
    ["ho gaya", ""],
    ["ho gya", ""],
    ["hogaya", ""],
    ["bas", ""],
    ["bas itna", ""],
    ["bas itna hi", ""],
    ["that's all", ""],
    ["that’s all", ""],
    ["that is all", ""],
    ["थैंक्स", ""],
    ["हो गया", ""],
    ["बस", ""],
    ["two butter chicken half, one naan, done", "two butter chicken half, one naan"],
    ["two butter chicken half, one naan, done.", "two butter chicken half, one naan"],
    ["Two Butter Chicken Half One Naan Done", "Two Butter Chicken Half One Naan"],
    ["ek butter naan ho gaya", "ek butter naan"],
    ["ek butter naan, ho gaya ji", "ek butter naan"],
    ["ek butter naan bas", "ek butter naan"],
    ["ek butter naan bas itna", "ek butter naan"],
    ["ek butter naan, bas itna hi", "ek butter naan"],
    ["do butter naan that's all", "do butter naan"],
    ["ek butter naan that is all", "ek butter naan"],
    ["ek butter naan done karo", "ek butter naan"],
    ["ek butter naan ok done", "ek butter naan"],
    ["butter naan थैंक्स", "butter naan"],
    ["butter naan हो गया", "butter naan"],
    ["ek butter naan done done", "ek butter naan"],
    ["add to order", ""], ["Add to order.", ""], ["add to cart", ""], ["add to the order", ""], ["add it", ""], ["add all", ""], ["add karo", ""], ["add kar do", ""], ["order mein daalo", ""], ["cart mein daalo", ""],
    ["ऐड टू ऑर्डर", ""], ["ऑर्डर में डालो", ""], ["कार्ट में डालो", ""], ["ऐड करो", ""],
    ["two butter chicken half, one naan, add to order", "two butter chicken half, one naan"],
    ["ek butter naan, do garlic naan add to cart please", "ek butter naan, do garlic naan"],
    ["ek butter naan order mein daalo", "ek butter naan"], ["ek butter naan cart mein daal do", "ek butter naan"], ["ek butter naan ok add to order", "ek butter naan"],
    ["ek butter naan ऑर्डर में डालो", "ek butter naan"],
    ["ek butter naan done please", "ek butter naan"],
  ])("%j is done, order %j", (text, rest) => {
    const r = splitDone(text, vmenu);
    expect(r.done).toBe(true);
    expect(r.rest).toBe(rest);
  });

  test.each([
    "ek butter naan",
    "one steak well done",
    "two steak medium well done",
    "ek butter naan ji",
    "done with the biryani please give two",      // not at the end
    "done naan",
    "add garlic naan",                              // an order for a dish, not the command
    "ek naan add",
    "ek order of naan",
    "",
  ])("%j is not done", (text) => {
    expect(splitDone(text, vmenu).done).toBe(false);
  });

  test("'bas' and 'thanks' alone are weak (an unfinished recogniser guess must not act on them); the rest are not", () => {
    expect(splitDone("ek naan bas", vmenu).weak).toBe(true);
    expect(splitDone("ek naan thanks", vmenu).weak).toBe(true);
    expect(splitDone("ek naan bas itna", vmenu).weak).toBe(false);
    expect(splitDone("ek naan done", vmenu).weak).toBe(false);
    expect(splitDone("ek naan ho gaya", vmenu).weak).toBe(false);
  });

  test("'daal do' (put it in) is done when the menu has no dal", () => {
    expect(splitDone("daal do", { menuWords: new Set(["naan"]) }).done).toBe(true);
    expect(splitDone("daal do", { menuWords: new Set(["naan"]) })).toEqual({ done: true, rest: "", weak: false });
    expect(splitDone("ek naan, daal do", { menuWords: new Set(["naan"]) }).rest).toBe("ek naan");
  });
  test("'daal do' is an order for the dal when the menu has a dal", () => {
    expect(splitDone("ek daal do", { menuWords: new Set(["dal", "makhani"]) }).done).toBe(false);
    expect(splitDone("ek naan daal do", { menuWords: new Set(["naan"]) }).done).toBe(true);
  });

  test("a dish named like the done words is a dish", () => {
    const menu = { menuWords: new Set(["bas", "done"]) };
    expect(splitDone("one bas", menu).done).toBe(false);
  });

  test("'well done' in the middle or at the end is a steak's doneness, a lone 'done' in the middle is dropped", () => {
    expect(scrubDone("one steak well done, one naan")).toBe("one steak well done, one naan");
    expect(scrubDone("two naan, done, one roti")).toBe("two naan, one roti");
    expect(splitDone("one steak well done, done", vmenu)).toMatchObject({ done: true, rest: "one steak well done" });
  });
});

describe("'done' is never glued into a dish, a table or a phrase (the parsers see only what was said before it)", () => {
  const rest = (t: string) => { const d = splitDone(t, vmenu); const c = detectCommand(d.rest, vmenu); return c.command ? c.rest : d.rest; };
  test("butter chicken done -> one line, nothing unmatched", () => {
    const p = parseOrder(rest("butter chicken done"), vmenu, {});
    expect(p.lines.map((l) => l.heard)).toEqual(["butter chicken"]);
    expect(p.unmatched).toEqual([]);
  });
  test("two butter chicken half, one naan, done -> no 'done' phrase", () => {
    const p = parseOrder(rest("two butter chicken half, one naan, done"), vmenu, {});
    expect(p.unmatched).toEqual([]);
    expect(p.lines.length).toBe(2);
  });
  test("ek tandoori done still asks which dish (it used to become one unmatched phrase)", () => {
    const p = parseOrder(rest("ek tandoori done"), vmenu, {});
    expect(p.unmatched).toEqual([]);
    expect(p.lines.filter((l) => l.ask).length).toBe(1);
  });
  test("table 3, done -> the table is read, 'done' is not a phrase", () => {
    const p = parseOrder(rest("ek butter naan, table 3, done"), vmenu, {});
    expect(p.unmatched).toEqual([]);
    expect(p.lines.length).toBe(1);
  });
  test("'done' never makes a command: place order / send to kitchen stay separate words", () => {
    for (const t of ["ek butter naan done", "done", "ho gaya", "bas", "that's all", "ek naan ok done", "ek naan add to order", "add to cart", "order mein daalo", "ek naan daal do"]) expect(detectCommand(t, vmenu).command, t).toBeNull();
    expect(detectCommand("ek butter naan, place order", vmenu).command).toBe("place");
  });
});

describe("parity corpus with 'done' appended: the same lines, 'done' never changes what was understood", () => {
  const dishCases = cases.filter((c) => !c.cat.startsWith("command") && !/(^|\W)(done|bas)(\W|$)/i.test(c.text));
  const sig = (t: string) => {
    const p = parseOrder(t, vmenu, {});
    return JSON.stringify([p.lines.map((l) => [l.itemId, l.variantId, l.qty, l.ask, l.note]), p.unmatched.map((u) => u.text), p.tableLabel, p.tableChoices]);
  };
  const tails = [", done", " done", ". Done.", " ok done", " ho gaya", " bas itna", " that's all", " done karo", ", add to order", " add to cart", " add it", " order mein daalo", " cart mein daalo",
    " don", " doen", " doan", " dun", " dhan", " dawn", " d one", " ad to order", " add to border", " add two order", " add tu order", " at to order", " add to odour"];
  test("the corpus has the dish utterances", () => expect(dishCases.length).toBeGreaterThan(250));
  for (const tail of tails) {
    test(`appending ${JSON.stringify(tail)} to every dish utterance`, () => {
      const bad: string[] = [];
      // a guess ("add to border") needs a dish understood before it: utterances with no dish on this menu are left out for those tails
      const guess = /border|odour|ad to|two order|tu order|at to/.test(tail);
      for (const c of dishCases.filter((x) => !guess || parseOrder(x.text, vmenu, {}).lines.length > 0)) {
        const d = splitDone(c.text + tail);
        if (!d.done || sig(d.rest) !== sig(c.text)) bad.push(`${c.id} ${JSON.stringify(c.text + tail)}`);
      }
      expect(bad.slice(0, 15)).toEqual([]);
    });
  }
  test("no corpus utterance (437) is itself read as 'done' unless it ends with the word", () => {
    // comm-429 "... order mein add karo" is labelled a dish for the place/kitchen commands; as the spoken "Add to order" it is done, and the dishes are the same
    const hits = cases.filter((c) => splitDone(c.text).done && c.id !== "comm-429").map((c) => `${c.id} ${c.text}`);
    expect(hits).toEqual([]);
  });
});

describe("the recogniser's slips for 'done' and 'add to order' (accents)", () => {
  const order3 = "two butter chicken half, one garlic naan, one masala dosa";
  test.each(["don", "doen", "doan", "doon", "dun", "dan", "dhun", "dhan", "dawn", "d one", "Don.", "DOEN!"])("%j at the end of a 3-item utterance is done (a finished result only)", (w) => {
    const r = splitDone(`${order3}, ${w}`);
    expect(r.done).toBe(true);
    expect(r.rest).toBe(order3);
    expect(r.weak).toBe(true);
  });
  test.each(["don", "doen", "doan", "doon", "dun", "dan", "dhun", "dhan", "dawn", "d one"])("%j alone is done (nothing understood: it just stops listening)", (w) => {
    expect(splitDone(w)).toMatchObject({ done: true, rest: "" });
  });
  test("Devanagari slips (the shared transliteration)", () => {
    for (const w of ["डन", "डोन", "डान", "डॉन", "दन"]) { const r = splitDone(`${order3} ${w}`); expect(r, w).toMatchObject({ done: true, rest: order3 }); }
  });
  test("a guess one letter from 'done' (not listed): done only with a dish understood before it", () => {
    expect(splitDone(`${order3}, dowe`)).toMatchObject({ done: true, rest: order3, weak: true });
    expect(splitDone(`${order3}, donz`)).toMatchObject({ done: true, rest: order3 });
    expect(splitDone(`${order3}, dnne`)).toMatchObject({ done: true, rest: order3 });
  });
  test("a guess alone, or with no dish understood before it, is ignored", () => {
    expect(splitDone("dowe").done).toBe(false);
    expect(splitDone("flibbertigibbet dowe").done).toBe(false);
    expect(splitDone("dowe", { menuWords: new Set<string>() }).done).toBe(false); // no hasDish: guesses are ignored
  });
  test.each(["dine", "dune", "dome", "bone", "gone", "none", "tone", "zone", "home", "cone", "dono", "dene", "one", "two", "half", "full", "doe"])("%j stays ordinary text", (w) => {
    expect(splitDone(`${order3}, ${w}`).done).toBe(false);
  });
  test("'dine in' and a table / type said last are not done", () => {
    for (const t of [`${order3}, dine in`, `${order3} dine`, "gone", "bone", "none", "one"]) expect(splitDone(t).done, t).toBe(false);
  });
  test("a word that is on the menu is never a slip ('Don Special', a dish with 'dan' in it)", () => {
    const menu = { menuWords: new Set(["don", "special", "naan"]), hasDish: () => true };
    expect(splitDone("one naan, don", menu).done).toBe(false);
    expect(splitDone("one don special", menu).done).toBe(false);
    expect(splitDone("one naan, dun", menu).done).toBe(true);
  });
  test.each(["ad to order", "add the order", "add two order", "add tu order", "at to order", "add to border", "add to odour", "add to odor", "add to ordar", "add to card", "ad to cart"])("'add to order' slip %j at the end of a 3-item utterance", (w) => {
    const r = splitDone(`${order3}, ${w}`);
    expect(r.done, w).toBe(true);
    expect(r.rest).toBe(order3);
  });
  test("slips of 'add to order' alone need a dish understood, so they are ignored", () => {
    expect(splitDone("add to border").done).toBe(false);
    expect(splitDone("add two order").done).toBe(false);
    expect(splitDone("add to order").done).toBe(true); // the listed words work alone
  });
  test("'add garlic naan' / 'two garlic naan add' are a dish and a verb, not the command", () => {
    expect(splitDone("add garlic naan").done).toBe(false);
    expect(splitDone("ek garlic naan add").done).toBe(false);
  });
});
