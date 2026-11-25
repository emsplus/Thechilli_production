import { describe, expect, it } from "vitest";
import { titleFor } from "./nav-items";

describe("top bar title", () => {
  it("names the page for direct links", () => {
    expect(titleFor("/pos")?.label).toBe("Chilli Agent");
    expect(titleFor("/pos")?.area).toBeUndefined();
  });
  it("back-office pages behind Manage show the section, never a bare 'Manage'", () => {
    expect(titleFor("/procurement")).toMatchObject({ area: "Manage", label: "Orders & receiving" });
    expect(titleFor("/audit")).toMatchObject({ area: "Manage", label: "Audit log" });
    expect(titleFor("/attendance")).toMatchObject({ area: "Manage", label: "Attendance" });
    // /manage has its own section menu and heading: the top bar stays "Manage"
    expect(titleFor("/manage", "menu")).toMatchObject({ label: "Manage" });
  });
  it("the screens that moved into Manage show 'Manage › <screen>' (the area hides on phones), Inventory shows its own name", () => {
    expect(titleFor("/reports")).toMatchObject({ area: "Manage", label: "Reports" });
    expect(titleFor("/cash")).toMatchObject({ area: "Manage", label: "Cash drawer" });
    expect(titleFor("/end-of-day")).toMatchObject({ area: "Manage", label: "End of day" });
    expect(titleFor("/reservations")).toMatchObject({ area: "Manage", label: "Reservations" });
    expect(titleFor("/customers")).toMatchObject({ area: "Manage", label: "Customers" });
    expect(titleFor("/manage", "inventory")).toMatchObject({ label: "Inventory" });
    expect(titleFor("/manage", "inventory")?.area).toBeUndefined();
  });
});
