import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AREAS, MANAGE_ENTRIES, MANAGE_GROUP_LABEL, MANAGE_TABS, activeAreaId, activeHref, bottomBar, landingFor, leafFor, manageTabFor, visibleAreas, visibleManageEntries, visibleManageTabs, type NavGate, type NavRole } from "./nav-model";

const APP = path.resolve(import.meta.dirname, "../../app");

const ids = (r: NavRole) => visibleAreas(r).map((a) => a.id);
const hrefsOf = (r: NavRole, g?: Parameters<typeof visibleAreas>[1]) => visibleAreas(r, g).flatMap((a) => a.items.map((i) => i.href));
const ROLES: NavRole[] = ["owner", "manager", "cashier", "waiter", "kitchen", "unknown", null];

describe("landingFor", () => {
  it("sends each role to its working screen", () => {
    expect(landingFor("owner")).toBe("/manage");
    expect(landingFor("manager")).toBe("/manage");
    expect(landingFor("cashier")).toBe("/pos");
    expect(landingFor("waiter")).toBe("/pos");
    expect(landingFor("kitchen")).toBe("/kitchen");
    expect(landingFor(null)).toBe("/pos");
  });
});

/** The permissions pos-service gives each system role (app/core/permissions.py), only the ones the navigation asks about. */
const POS_PERMS = ["orders.create", "kot.view", "crm.read", "crm.write"];
const ADMIN_PERMS = ["reports.view", "reports.close_day", "menu.manage", "tables.manage", "inventory.manage", "purchases.manage", "staff.view", "settings.manage", "printing.manage", "system.view", "delivery.manage", "billing.view"];
const PERMS: Record<string, string[]> = {
  owner: [...POS_PERMS, "cashier.shift", "reservations.manage", ...ADMIN_PERMS],
  manager: [...POS_PERMS, "cashier.shift", "reservations.manage", ...ADMIN_PERMS],
  cashier: [...POS_PERMS, "cashier.shift", "reservations.manage"],
  waiter: [...POS_PERMS, "reservations.manage"],
  kitchen: ["kot.view"],
};
const gateOf = (role: string): NavGate => ({ can: (p) => PERMS[role].includes(p), feature: () => true, has: () => true });
const labelsOf = (r: NavRole, g?: NavGate) => visibleAreas(r, g).flatMap((a) => a.items.map((i) => i.label));
const manageOf = (r: string) => visibleManageEntries(r as NavRole, gateOf(r)).map((e) => e.label);

describe("sidebar: only Chilli Agent, Orders, Kitchen, Inventory and Manage", () => {
  it("owner and manager see exactly those five, in two sections", () => {
    for (const r of ["owner", "manager", "unknown"] as NavRole[]) {
      expect(labelsOf(r)).toEqual(["Chilli Agent", "Orders", "Kitchen", "Inventory", "Manage"]);
      expect(hrefsOf(r)).toEqual(["/pos", "/orders", "/kitchen", "/manage?tab=inventory", "/manage"]);
      expect(ids(r)).toEqual(["sell", "admin"]);
    }
    expect(AREAS).toHaveLength(2);
  });
  it("nothing that moved into Manage is a sidebar item any more", () => {
    for (const r of ROLES) for (const gone of ["/reservations", "/customers", "/reports", "/cash", "/end-of-day"]) expect(hrefsOf(r)).not.toContain(gone);
    for (const r of Object.keys(PERMS)) for (const gone of ["Reservations", "Customers", "Reports", "Cash drawer", "End of day"]) expect(labelsOf(r as NavRole, gateOf(r))).not.toContain(gone);
  });
  it("no top-bar duplicates: Alerts and Ask AI are reached from the bell and the sparkle", () => {
    for (const r of ROLES) { expect(hrefsOf(r)).not.toContain("/alerts"); expect(hrefsOf(r)).not.toContain("/ai"); }
    expect(leafFor("/alerts")?.leaf.label).toBe("Alerts");
    expect(leafFor("/ai")?.leaf.label).toBe("Ask AI");
  });
  it("role matrix with the server's permissions", () => {
    expect(labelsOf("owner", gateOf("owner"))).toEqual(["Chilli Agent", "Orders", "Kitchen", "Inventory", "Manage"]);
    expect(labelsOf("manager", gateOf("manager"))).toEqual(["Chilli Agent", "Orders", "Kitchen", "Inventory", "Manage"]);
    // cashier and waiter have no Inventory but keep Manage: it is where their Customers / Cash drawer / Reports went
    expect(labelsOf("cashier", gateOf("cashier"))).toEqual(["Chilli Agent", "Orders", "Kitchen", "Manage"]);
    expect(labelsOf("waiter", gateOf("waiter"))).toEqual(["Chilli Agent", "Orders", "Kitchen", "Manage"]);
    expect(labelsOf("kitchen", gateOf("kitchen"))).toEqual(["Kitchen"]);
  });
  it("without permissions loaded yet the role alone decides (cashier keeps Manage, kitchen has only the kitchen screen)", () => {
    expect(labelsOf("cashier")).toEqual(["Chilli Agent", "Orders", "Kitchen", "Manage"]);
    expect(labelsOf("waiter")).toEqual(["Chilli Agent", "Orders", "Kitchen", "Manage"]);
    expect(hrefsOf("kitchen")).toEqual(["/kitchen"]);
  });
  it("Inventory needs the inventory permission and a plan with inventory; Manage stays", () => {
    const noInv = { can: (p: string) => p !== "inventory.manage", feature: () => true };
    expect(labelsOf("owner", noInv)).toEqual(["Chilli Agent", "Orders", "Kitchen", "Manage"]);
    expect(labelsOf("owner", { can: () => true, feature: (c) => c !== "inventory" })).toEqual(["Chilli Agent", "Orders", "Kitchen", "Manage"]);
  });
  it("never shows an empty section", () => {
    for (const r of ROLES) for (const a of visibleAreas(r)) expect(a.items.length).toBeGreaterThan(0);
  });
});

describe("the Manage panel lists every screen that left the sidebar, once", () => {
  it("lists the groups in order: Overview, Operations, Set up", () => {
    expect(MANAGE_ENTRIES.map((e) => e.label)).toEqual(["Overview", "Reservations", "Customers", "Customers", "Reports", "Cash drawer", "End of day",
      "Menu", "Tables", "Reviews", "Recipes", "Inventory", "Suppliers & Purchases", "Staff", "Restaurant", "Billing", "Features", "Printers", "Devices", "Delivery", "System"]);
    expect(MANAGE_ENTRIES.map((e) => e.group).filter((g, i, a) => a.indexOf(g) === i)).toEqual(["main", "operations", "setup"]);
    expect(MANAGE_GROUP_LABEL).toEqual({ main: null, operations: "Operations", setup: "Set up" });
  });
  it("owner / manager: Reservations, Customers, Reports, Cash drawer and End of day are in Operations; Customers only once", () => {
    for (const r of ["owner", "manager"]) {
      const e = visibleManageEntries(r as NavRole, gateOf(r));
      expect(e.filter((x) => x.group === "operations").map((x) => x.label)).toEqual(["Reservations", "Customers", "Reports", "Cash drawer", "End of day"]);
      expect(e.filter((x) => x.label === "Customers")).toHaveLength(1);
      expect(e.find((x) => x.label === "Customers")?.href).toBe("/manage?tab=customers");
      expect(e.map((x) => x.label)).toEqual(["Overview", "Reservations", "Customers", "Reports", "Cash drawer", "End of day", "Menu", "Tables", "Reviews", "Recipes", "Inventory", "Staff", "Restaurant", "Billing", "Printers", "Delivery"]);
    }
  });
  it("owner: every moved screen keeps its own URL", () => {
    const h = Object.fromEntries(visibleManageEntries("owner", gateOf("owner")).map((e) => [e.label, e.href]));
    expect(h).toMatchObject({ Reservations: "/reservations", Reports: "/reports", "Cash drawer": "/cash", "End of day": "/end-of-day", Inventory: "/manage?tab=inventory" });
  });
  it("cashier gets Customers and Cash drawer (Reports too only when the permission is granted); waiter only Customers; kitchen nothing", () => {
    expect(manageOf("cashier")).toEqual(["Customers", "Cash drawer"]);
    expect(visibleManageEntries("cashier", { can: () => true, feature: () => true }).map((e) => e.label)).toEqual(["Customers", "Reports", "Cash drawer"]);
    expect(visibleManageEntries("cashier").map((e) => `${e.label}:${e.href}`)).toEqual(["Customers:/customers", "Reports:/reports", "Cash drawer:/cash"]);
    expect(manageOf("waiter")).toEqual(["Customers"]);
    expect(manageOf("kitchen")).toEqual([]);
    expect(visibleManageEntries(null as NavRole).map((e) => e.label)).toEqual(["Customers", "Reports", "Cash drawer"]);
    expect(visibleManageTabs("cashier")).toEqual([]);
  });
  it("offline (role unknown) lists each label once", () => {
    const labels = visibleManageEntries("unknown").map((e) => e.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
  it("every moved screen is a page that exists, and its route is covered by the Manage sidebar item", () => {
    for (const e of MANAGE_ENTRIES.filter((x) => x.kind === "page")) {
      expect(existsSync(path.join(APP, e.href, "page.tsx"))).toBe(true);
      expect(existsSync(path.join(APP, e.href, "layout.tsx"))).toBe(true); // the layout draws the Manage frame
      expect(leafFor(e.href)?.leaf.href).toBe("/manage");
    }
  });
  it("cashier: the entries a role cannot use are not listed (no Reservations, End of day, Menu ...)", () => {
    const l = visibleManageEntries("cashier").map((e) => e.label);
    for (const no of ["Reservations", "End of day", "Menu", "Staff", "Inventory", "System"]) expect(l).not.toContain(no);
  });
  it("lists the original sections in order", () => {
    expect(MANAGE_TABS.map((t) => t.label)).toEqual(["Overview", "Customers", "Menu", "Tables", "Reviews", "Recipes", "Inventory", "Suppliers & Purchases", "Staff", "Restaurant", "Billing", "Features", "Printers", "Devices", "Delivery", "System"]);
  });
  it("maps routes and old tab names to the entry that holds them", () => {
    expect(manageTabFor("/manage", "menu")?.label).toBe("Menu");
    expect(manageTabFor("/manage", "purchases")?.label).toBe("Suppliers & Purchases");
    expect(manageTabFor("/manage", "outlets")?.label).toBe("Restaurant");
    expect(manageTabFor("/manage", "inventory")?.label).toBe("Inventory");
    expect(manageTabFor("/manage", null)?.label).toBe("Overview");
    expect(manageTabFor("/modifiers")?.label).toBe("Menu");
    expect(manageTabFor("/offers")?.label).toBe("Menu");
    expect(manageTabFor("/attendance")?.label).toBe("Staff");
    expect(manageTabFor("/audit")?.label).toBe("System");
    expect(manageTabFor("/reports")?.label).toBe("Reports");
    expect(manageTabFor("/cash")?.label).toBe("Cash drawer");
    expect(manageTabFor("/end-of-day")?.label).toBe("End of day");
    expect(manageTabFor("/reservations")?.label).toBe("Reservations");
    expect(manageTabFor("/pos")).toBeUndefined();
  });
  it("keeps the panel's old gating for the tabs: Tables / Delivery by business type, Reviews / Delivery / Billing by permission, the rest always (owner / manager)", () => {
    const t = visibleManageTabs("owner", { can: (p) => !["reports.view", "delivery.manage", "billing.view", "system.view", "inventory.manage"].includes(p), feature: (c) => c !== "inventory", has: (c) => c !== "tables" }).map((x) => x.label);
    expect(t).toEqual(["Overview", "Customers", "Menu", "Recipes", "Inventory", "Staff", "Restaurant", "Features", "Printers"]);
  });
  it("entries whose permission is missing are hidden (Reports, Reservations, End of day)", () => {
    const l = visibleManageEntries("owner", { can: (p) => !["reports.view", "reservations.manage", "reports.close_day"].includes(p), feature: () => true }).map((x) => x.label);
    for (const no of ["Reports", "Reservations", "End of day"]) expect(l).not.toContain(no);
    expect(l).toContain("Cash drawer");
  });
});

describe("highlight: Inventory lights its own item, Manage every other Manage page", () => {
  const owner = hrefsOf("owner");
  it("the Inventory tab lights Inventory, not Manage", () => {
    expect(activeHref("/manage", "inventory", owner)).toBe("/manage?tab=inventory");
    expect(leafFor("/manage", "inventory")?.leaf.label).toBe("Inventory");
  });
  it("every other Manage tab and the Manage overview light Manage", () => {
    for (const tab of [null, "overview", "menu", "tables", "customers", "recipes", "suppliers", "purchases", "staff", "restaurant", "billing", "printers", "devices", "system"]) {
      expect(activeHref("/manage", tab, owner), String(tab)).toBe("/manage");
    }
  });
  it("the moved screens and the old back-office routes light Manage", () => {
    for (const p of ["/reservations", "/customers", "/reports", "/cash", "/end-of-day", "/end-of-day/", "/modifiers", "/offers", "/attendance", "/procurement", "/audit", "/system"]) expect(activeHref(p, null, owner), p).toBe("/manage");
  });
  it("the working screens light themselves", () => {
    expect(activeHref("/pos", null, owner)).toBe("/pos");
    expect(activeHref("/orders/abc", null, owner)).toBe("/orders");
    expect(activeHref("/kitchen", null, owner)).toBe("/kitchen");
  });
  it("Inventory tab opened by someone whose list has no Inventory item lights Manage instead of nothing", () => {
    expect(activeHref("/manage", "inventory", ["/pos", "/orders", "/kitchen", "/manage"])).toBe("/manage");
  });
});

describe("bottomBar (phones): the same destinations as the sidebar", () => {
  it("has at most 4 slots (+ More) for every role", () => {
    for (const r of ROLES) expect(bottomBar(r).slots.length).toBeLessThanOrEqual(4);
  });
  it("owner / manager: Chilli Agent, Orders, Inventory, Manage; Kitchen goes to More", () => {
    for (const r of ["owner", "manager"]) {
      const b = bottomBar(r as NavRole, gateOf(r));
      expect(b.slots.map((s) => s.label)).toEqual(["Chilli Agent", "Orders", "Inventory", "Manage"]);
      expect(b.slots.map((s) => s.href)).toEqual(["/pos", "/orders", "/manage?tab=inventory", "/manage"]);
      expect(b.more.flatMap((a) => a.items.map((i) => i.href))).toEqual(["/kitchen"]);
    }
  });
  it("cashier and waiter: Chilli Agent, Orders, Kitchen, Manage; nothing else in More", () => {
    for (const r of ["cashier", "waiter"]) {
      const b = bottomBar(r as NavRole, gateOf(r));
      expect(b.slots.map((s) => s.label)).toEqual(["Chilli Agent", "Orders", "Kitchen", "Manage"]);
      expect(b.more).toEqual([]);
    }
  });
  it("kitchen: the kitchen screen only; a plan without inventory gives the owner Kitchen in the bar", () => {
    expect(bottomBar("kitchen", gateOf("kitchen")).slots.map((s) => s.label)).toEqual(["Kitchen"]);
    expect(bottomBar("owner", { can: () => true, feature: (c) => c !== "inventory" }).slots.map((s) => s.label)).toEqual(["Chilli Agent", "Orders", "Kitchen", "Manage"]);
  });
});

describe("route to section", () => {
  it("maps existing routes", () => {
    expect(activeAreaId("/pos")).toBe("sell");
    expect(activeAreaId("/orders/abc")).toBe("sell");
    expect(activeAreaId("/today")).toBeUndefined(); // only a redirect to /manage now
    expect(activeAreaId("/customers")).toBe("admin"); // lives under Manage
    expect(activeAreaId("/end-of-day")).toBe("admin");
    expect(activeAreaId("/manage", "menu")).toBe("admin");
    expect(activeAreaId("/manage", "inventory")).toBe("admin");
    expect(activeAreaId("/offers")).toBe("admin");
    expect(activeAreaId("/audit")).toBe("admin");
    expect(activeAreaId("/nope")).toBeUndefined();
  });
});

describe("permission and entitlement gating", () => {
  const all = { can: () => true, feature: () => true };
  it("a gate that allows everything changes nothing", () => {
    for (const r of ROLES) expect(hrefsOf(r, all)).toEqual(hrefsOf(r));
  });
  it("hides entries whose permission is missing, even for a role that normally sees them", () => {
    const gate = { can: (p: string) => p !== "reservations.manage" && p !== "reports.view", feature: () => true };
    const m = visibleManageEntries("manager", gate).map((e) => e.href);
    expect(m).not.toContain("/reservations");
    expect(m).not.toContain("/reports");
    expect(m).toContain("/cash");
    expect(hrefsOf("manager", { can: (p) => p !== "inventory.manage", feature: () => true })).not.toContain("/manage?tab=inventory");
  });
});

describe("business type (docs/BUSINESS_TYPES.md)", () => {
  const all = { can: () => true, feature: () => true };
  it("a cloud kitchen has no Reservations and no Tables section; Delivery shows with the capability", () => {
    const kitchen = { ...all, has: (c: string) => !["reservations", "tables", "dine_in", "outdoor"].includes(c) };
    expect(visibleManageEntries("owner", kitchen).map((e) => e.href)).not.toContain("/reservations");
    const tabs = visibleManageTabs("owner", kitchen).map((t) => t.label);
    expect(tabs).not.toContain("Tables");
    expect(tabs).toContain("Delivery");
  });
  it("a restaurant without the delivery module has no Delivery section; no capability info = restaurant", () => {
    const rest = { ...all, has: (c: string) => c !== "delivery_orders" && c !== "aggregator" };
    expect(visibleManageTabs("owner", rest).map((t) => t.label)).not.toContain("Delivery");
    expect(visibleManageEntries("owner", rest).map((e) => e.href)).toContain("/reservations");
    expect(visibleManageEntries("owner", all).map((e) => e.href)).toContain("/reservations");
  });
});

describe("owner 2026-11-13: System, Devices and Suppliers & Purchases are not shown in Manage (UI only)", () => {
  it("none of the three is listed for any role, the pages stay reachable by their old links", () => {
    for (const role of ["owner", "manager", "cashier", "waiter", "kitchen"] as const) {
      const l = visibleManageEntries(role).map((x) => x.label);
      for (const no of ["System", "Devices", "Suppliers & Purchases"]) expect(l).not.toContain(no);
    }
    expect(MANAGE_TABS.map((t) => t.label)).toEqual(expect.arrayContaining(["System", "Devices", "Suppliers & Purchases"]));
    expect(manageTabFor("/manage", "purchases")?.label).toBe("Suppliers & Purchases");
  });
});

describe("feature access (Manage > Features: super admin grants, the owner switches)", () => {
  const all: NavGate = { can: () => true, feature: () => true, has: () => true };
  const without = (...codes: string[]): NavGate => ({ ...all, feature: (c: string) => !codes.includes(c) });
  const labels = (r: NavRole, g: NavGate) => visibleManageEntries(r, g).map((x) => x.label);

  it("the Features tab is the owner's: not the manager's, and not without settings.owner", () => {
    expect(labels("owner", all)).toContain("Features");
    expect(labels("manager", all)).not.toContain("Features");
    expect(labels("owner", { ...all, can: (p: string) => p !== "settings.owner" })).not.toContain("Features");
  });
  it("a module switched off leaves Manage: Reports, Cash drawer, Customers (tab and page)", () => {
    expect(labels("owner", without("reports"))).not.toContain("Reports");
    expect(labels("owner", without("cash_drawer"))).not.toContain("Cash drawer");
    expect(labels("owner", without("customers"))).not.toContain("Customers");
    expect(labels("cashier", without("customers"))).not.toContain("Customers"); // the page the cashier / waiter reach it by
    expect(labels("cashier", without("reports"))).not.toContain("Reports");
    // ... and nothing else goes with them
    expect(labels("owner", without("reports", "cash_drawer", "customers"))).toEqual(
      labels("owner", all).filter((l) => !["Reports", "Cash drawer", "Customers"].includes(l)));
  });
  it("on (or not told) shows everything, as before", () => {
    expect(labels("owner", all)).toEqual(expect.arrayContaining(["Reports", "Cash drawer", "Customers", "Features"]));
  });
});
