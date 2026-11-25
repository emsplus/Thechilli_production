import { describe, expect, it } from "vitest";
import type { DiningTable } from "@/lib/types";
import { tablesForType } from "./tickets";

const T = (id: string, area: DiningTable["area"]): DiningTable => ({ id, label: id, seats: 4, area });
const ALL = [T("T1", "indoor"), T("T2", "indoor"), T("O1", "outdoor"), T("O2", "outdoor")];

describe("tablesForType (owner: indoor and outdoor tables must not be mixed in one list)", () => {
  it("Dine-in (indoor) offers only the indoor tables", () => {
    expect(tablesForType(ALL, "indoor").map((x) => x.id)).toEqual(["T1", "T2"]);
  });
  it("Outdoor offers only the outdoor tables", () => {
    expect(tablesForType(ALL, "outdoor").map((x) => x.id)).toEqual(["O1", "O2"]);
  });
  it("takeaway and delivery need no table, the list is untouched", () => {
    expect(tablesForType(ALL, "takeaway")).toHaveLength(4);
    expect(tablesForType(ALL, "delivery")).toHaveLength(4);
  });
  it("a restaurant with no outdoor tables gets an empty list for Outdoor (the panel then says so)", () => {
    expect(tablesForType([T("T1", "indoor")], "outdoor")).toEqual([]);
  });
});
