import { describe, expect, test } from "vitest";
import { afterWake, findWake, phoneticKey, soundsLikeZonov, stripWakes } from "./wakeWord";

// "Hey Zonov" as recognisers return it for the owner's Indian accent (docs/VOICE_QA_REPORT.md B13). Normal sensitivity.
const wakes = (s: string, sens: "strict" | "normal" | "lenient" = "normal") => findWake(s, sens) !== null;

const POSITIVE = [
  // the owner's reports
  "hey jonov", "hey sonov", "a zonov", "hey zonoff", "hey zonav", "he zono", "hey jonoff", "hey sunao",
  "हे ज़ोनोव", "हे जोनोव", "हे सोनोव",
  // spellings of the name
  "hey zonov", "Hey Zonov", "HEY ZONOV!", "Hey, Zonov.", "hey zonof", "hey zonove", "hey zonow", "hey zonaw", "hey zanov", "hey zinov", "hey zenov",
  "hey zunov", "hey zonoh", "hey zono", "hey zonu", "hey jono", "hey jonu", "hey jonav", "hey jonaff", "hey yonov", "hey shonov", "hey xonov",
  "hey zonnov", "hey zonoov", "hey zonoph", "hey sonoff", "hey sonav", "hey sunav", "hey zonaao", "hey jonao", "hey sonao",
  // greetings
  "hay zonov", "hei jonov", "hi zonov", "hai jonov", "haay zonov", "ok zonov", "okay jonov", "hello zonov", "arey zonov", "arre jonov", "are zonov",
  "e zonov", "ae jonov", "eh zonov",
  // Devanagari greetings and names
  "हेय ज़ोनोव", "है जोनोव", "ए ज़ोनोव", "अरे ज़ोनोव", "हे ज़ोनव", "हे ज़ोनॉफ", "हे ज़ोनो", "हे सुनाओ", "हाय ज़ोनोव",
  // run together, split
  "heyzonov", "heyjonov", "hizonov", "okayjonov", "hejonov", "hey zo nov", "hey jo nov", "hey z nov", "hey zone off", "hey zone of", "hey zoh nov",
  // in context, with the order straight after it, interim fragments
  "hey jonov one lassi", "hey sonov, two matar paneer",
  // what Chrome en-IN wrote for the owner's "Hey Zonov" (live log 2026-11-02)
  "hey Jon", "hey Jono", "hey jonu", "hey jeno", "hey Jonas", "hey jonav", "hey John, table 4", "a jono",
  // the name alone as the first word of a phrase, said fast (owner, B18)
  "zonov", "Zonov.", "jonov one lassi", "zonoff", "hazonov", "ahzonov", "two lassi, zonov", "so er hey zonov", "um ok jonov", "a zonov two coke", "हे जोनोव एक लस्सी",
];

const NEGATIVE = [
  "", "sunao", "sonu", "sunao bhai", "two lassi zonov", "zone off", "zoom", "novel", "honey", "jaanu", "hello", "zero", "hey", "hey there", "hello how are you",
  "hey sonu", "hey jaanu", "hey zoom", "hey honey", "hey zero", "hey zone", "hey novel", "hey sona", "hey son", "hi son", "hey soda",
  "hey mango", "hey money", "hey man", "hey noodles", "hey jo", "ok zo", "hey moon", "hey chilli", "hey sunny", "hey johnny",
  "hey zara", "hey sanam", "two lamb karahi", "one jeera rice", "zinger burger", "son of a chef", "table five please", "hey sir",
  // live room talk shared by the owner's testing (2026-11-02): never a wake
  "unka kya naam hai, suman tumne kya bag nikaali abhi", "done mein hardcore kar rakha hai ya sirf like done karte hi cute hi ja",
  "a sonu", "hey zinc", "hey snow", "hey zen", "hello john", "hey johnny", "jono two lassi", "हे सोनू", "हे जानू", "सुनाओ", "हैलो",
];

describe("wake phrase: accepted (normal sensitivity)", () => {
  test("at least 60 variants", () => { expect(POSITIVE.length).toBeGreaterThanOrEqual(60); });
  test.each(POSITIVE)("%j wakes", (s) => { expect(wakes(s), `${s} -> ${s.split(/\s+/).map(phoneticKey).join(" ")}`).toBe(true); });
});

describe("wake phrase: refused (normal sensitivity)", () => {
  test("at least 30 variants", () => { expect(NEGATIVE.length).toBeGreaterThanOrEqual(30); });
  test.each(NEGATIVE)("%j does not wake", (s) => { expect(wakes(s), `${s} -> ${s.split(/\s+/).map(phoneticKey).join(" ")}`).toBe(false); });
});

describe("phonetic key", () => {
  test.each([["zonov", "ZANAV"], ["jonoff", "ZANAV"], ["sonov", "ZANAV"], ["sunao", "ZANAV"], ["zanav", "ZANAV"], ["shonov", "ZANAV"], ["zonoph", "ZANAV"], ["ज़ोनोव", "ZANAV"],
    ["zono", "ZANA"], ["sonu", "ZANA"], ["honey", "HANA"], ["zoom", "ZAM"]])("%s -> %s", (w, k) => { expect(phoneticKey(w)).toBe(k); });
});

describe("sensitivity", () => {
  test("strict: exact sound after a full greeting only", () => {
    expect(wakes("hey zonov", "strict")).toBe(true);
    expect(wakes("hey jonoff", "strict")).toBe(true); // same key
    expect(wakes("hey zono", "strict")).toBe(false);
    expect(wakes("a zonov", "strict")).toBe(false);
    expect(wakes("he zonov", "strict")).toBe(false);
  });
  test("lenient: one more sound off, and 'a' anywhere", () => {
    expect(wakes("hey sonu", "lenient")).toBe(true);
    expect(wakes("so a zonov", "lenient")).toBe(true);
    expect(wakes("so a zonov", "normal")).toBe(false);
    expect(wakes("hey mango", "lenient")).toBe(false);
    expect(wakes("hello", "lenient")).toBe(false);
  });
  test("single words", () => {
    for (const w of ["zonov", "jonov", "sonoff", "zono", "jono", "sunao"]) expect(soundsLikeZonov(w), w).toBe(true);
    for (const w of ["zone", "sonu", "jaanu", "soda", "son", "nov", "zoom", "sofa"]) expect(soundsLikeZonov(w), w).toBe(false);
  });
});

describe("what follows it", () => {
  test("order words right after the wake phrase", () => {
    expect(afterWake("hey jonov one lassi")!.rest).toBe("one lassi");
    expect(afterWake("हे जोनोव, एक लस्सी")!.rest).toBe("एक लस्सी");
    expect(afterWake("hey zone off two butter naan")!.rest).toBe("two butter naan");
    expect(stripWakes("one lassi, hey sonov, two roti")).toBe("one lassi, two roti");
  });
});

describe("'hey you know' (live log): only as another guess", () => {
  test("never from the words shown, yes from a 2nd / 3rd guess", () => {
    expect(findWake("hey you know")).toBeNull();
    expect(findWake("hey you know", "normal", { otherGuess: true })).not.toBeNull();
    expect(findWake("hey you know", "strict", { otherGuess: true })).toBeNull();
  });
});
