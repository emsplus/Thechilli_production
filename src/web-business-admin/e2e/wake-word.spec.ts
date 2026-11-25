import { expect, test } from "@playwright/test";
import { afterWake, findWake, soundsLikeZonov } from "../src/lib/wakeWord";

/** Pure-module specs (no browser): the "Hey Zonov" wake phrase. */

const wakes = (s: string) => findWake(s) !== null;

/** Every second-word spelling a recogniser may produce (owner: "jonov zonov yonov sab dekh lena"). */
const VARIANTS = ["zonov", "zonoff", "zonof", "zonove", "zonoy", "zonow", "zonav", "zonaw", "zanov", "zinov", "zenov", "zonoh", "zono", "zonu", "zunov",
  "jonov", "jonoff", "jonof", "jonove", "jonav", "yonov", "yonoff", "yonof", "yonove", "sonov", "sonoff", "sonof", "shonov", "xonov", "xonoff",
  "z nov", "zo nov", "zoh nov", "jo nov", "zone off", "zone of", "zone ov", "jono"];

test("every spelling of Zonov wakes it after a greeting", () => {
  for (const v of VARIANTS) for (const g of ["hey", "hi", "ok"]) expect(wakes(`${g} ${v}`), `${g} ${v}`).toBe(true);
});

test("the phrase in context, greetings, punctuation and run-together forms", () => {
  for (const s of [
    "Hey Zonov", "hey zonov", "HEY ZONOV!", "Hey, Zonov.", "hay zonov", "hei zonov", "hi jonov", "hai yonov", "he zonov", "hello zonov",
    "okay zonoff", "arey zonov", "heyzonov", "okayjonov", "hizonov", "Hey Zonov?", "A zonov, two coke", "so er hey zonov", "um, ok jonov", "hey Zonov two coke",
  ]) expect(wakes(s), s).toBe(true);
});

test("the name alone wakes it as the first word of a phrase (owner 2026-11-02)", () => {
  for (const s of ["zonov", "Zonov two coke", "jonov", "sonov", "hazonov"]) expect(wakes(s), s).toBe(true);
});

test("ordinary talk, dish names, quantities, or only one of the two words does not wake it", () => {
  for (const s of [
    "", "zone off", "two lassi zonov", "lamb karahi", "two lamb karahi", "hey karahi", "hey", "hey there", "hi", "okay", "hello how are you",
    "can you check the oven", "hey mango", "hey money", "hey man", "table five please", "bill number two dine in",
    "one noodles", "two soda", "jeera rice", "zinger burger", "one nan off", "hey noodles", "hey soda", "hi son", "hey zone", "ok zo", "hey jo",
    "hey moon", "hey chilli", "son of a chef",
  ]) expect(wakes(s), s).toBe(false);
});

test("what follows the wake phrase is returned; nothing before it", () => {
  let a = afterWake("Hey Zonov, bill number 2, 2 chicken tikka, dine in table 5, name Raj")!;
  expect(a.rest).toBe("bill number 2, 2 chicken tikka, dine in table 5, name Raj");
  a = afterWake("hey zonov 2 coke")!;
  expect(a.rest).toBe("2 coke");
  expect(afterWake("hey zone off two butter naan")!.rest).toBe("two butter naan");
  expect(afterWake("blah blah we need ketchup hey zonov two lamb karahi")!.rest).toBe("two lamb karahi"); // before: dropped
  expect(afterWake("Hey Zonov")!.rest).toBe("");
  expect(afterWake("heyzonov ek coke")!.rest).toBe("ek coke");
  expect(afterWake("two lamb karahi")).toBeNull();
  // the FIRST wake phrase wins; a second one later is part of the order text
  expect(afterWake("hey zonov ek coke hey zonov do naan")!.rest).toBe("ek coke hey zonov do naan");
  const w = findWake("so hey zonov ek coke")!;
  expect("so hey zonov ek coke".slice(w.start, w.end)).toBe("hey zonov");
});

test("single words", () => {
  for (const w of ["zonov", "Zonov", "jonov", "yonov", "sonoff", "shonov", "zonove", "zono", "jono"]) expect(soundsLikeZonov(w), w).toBe(true);
  for (const w of ["noodles", "soda", "zinger", "son", "zone", "sofa", "money", "nov", "karahi", "moon", "chilli"]) expect(soundsLikeZonov(w), w).toBe(false);
});
