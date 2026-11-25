import { describe, expect, test } from "vitest";
import { GRAMMAR, isDetection } from "./wakeDetector";
import { dropWakeWords } from "@/app/pos/_components/VoiceOrder";

// The offline wake detector (docs/VOICE_QA_REPORT.md "Offline detector"): what its restricted-grammar output means.
describe("detector output -> wake (measured thresholds)", () => {
  const w = (t: string, c: number[]) => ({ text: t, partial: false, conf: null, words: t.split(" ").map((word, i) => ({ word, conf: c[i] ?? 1 })) });
  test("the grammar: target phrases, decoys for everyday talk near them, and [unk]", () => {
    expect(GRAMMAR).toContain("[unk]");
    expect(GRAMMAR).toEqual(expect.arrayContaining(["hey zone of", "hey joe nov", "hey john of", "hey so new", "the zone", "hey john"]));
  });
  test("normal: a final result STARTING with 'hey' + the phrase, matched words >= 0.6", () => {
    expect(isDetection(w("hey zone of", [0.9, 0.8, 0.7]), "normal")).toBe(true);
    expect(isDetection(w("[unk] hey joe nov [unk]", [1, 0.9, 0.7, 0.8, 1]), "normal")).toBe(true);
    expect(isDetection(w("hey zone of", [0.9, 0.5, 0.9]), "normal")).toBe(false);
    expect(isDetection(w("zone of", [1, 1]), "normal")).toBe(false); // no "hey"
    expect(isDetection(w("the zone of", [1, 1, 1]), "normal")).toBe(false); // not at the start
    expect(isDetection(w("hey so new", [1, 1, 1]), "normal")).toBe(false); // a decoy
    expect(isDetection({ text: "hey zone of", partial: true, conf: null }, "normal")).toBe(false); // partials never wake
  });
  test("strict needs 0.85; lenient takes the name without 'hey'", () => {
    expect(isDetection(w("hey zone of", [0.9, 0.8, 0.9]), "strict")).toBe(false);
    expect(isDetection(w("hey zone of", [0.9, 0.9, 0.9]), "strict")).toBe(true);
    expect(isDetection(w("john of", [0.8, 0.8]), "lenient")).toBe(true);
  });
});

describe("the wake words are dropped from the server's transcript after a detector wake", () => {
  test.each([
    ["Hey Zonov, one lassi please", "one lassi please"], ["hey John of two chapati", "two chapati"], ["Jono, ek matar paneer", "ek matar paneer"],
    ["hey zone of do lassi", "do lassi"], ["one lassi", "one lassi"],
  ])("%j -> %j", (t, want) => { expect(dropWakeWords(t)).toBe(want); });
});
