import { ApiError, api } from "./api";
import type { Me, RoleDef } from "./types";

/** A server that has no custom-role API (or no such route yet) answers 404 / 405 / 501: the UI then explains it instead of failing. */
export const isUnsupported = (e: unknown) => e instanceof ApiError && (e.status === 404 || e.status === 405 || e.status === 501);

/**
 * Does this user hold `perm`? Uses the server's list from /auth/me; an older server that sends none falls back to `fallback` (what the
 * old UI did: owner-only). Hides UI only; the API enforces.
 */
export const hasPerm = (me: Pick<Me, "permissions">, perm: string, fallback: boolean) => (me.permissions ? me.permissions.includes(perm) : fallback);

export interface PermGroup { id: string; label: string; perms: { code: string; label: string }[] }
/** Permission catalogue (pos-service docs/PERMISSIONS.md). Unknown codes from the server are shown under "Other" so nothing is hidden. */
export const PERMISSION_GROUPS: PermGroup[] = [
  { id: "sell", label: "Selling", perms: [
    { code: "orders.create", label: "Take orders" }, { code: "orders.update", label: "Change orders" }, { code: "orders.cancel", label: "Cancel orders" },
    { code: "kot.send", label: "Send to kitchen" }, { code: "kot.view", label: "See kitchen tickets" }, { code: "kot.update_status", label: "Update kitchen tickets" },
    { code: "tables.manage", label: "Manage tables" }, { code: "sync.push", label: "Sync offline work" }, { code: "voice.use", label: "Voice ordering" },
  ] },
  { id: "money", label: "Bills and payments", perms: [
    { code: "bills.finalize", label: "Create bills" }, { code: "bills.receipt", label: "See and share bills" }, { code: "bills.discount", label: "Give discounts" },
    { code: "bills.discount.over_limit", label: "Discount above the cashier limit" }, { code: "bills.amend", label: "Correct finalized bills" }, { code: "bills.void", label: "Void bills" },
    { code: "payments.record", label: "Take payments" }, { code: "payments.online", label: "UPI and online payments" }, { code: "payments.setup", label: "Set up payment provider" },
    { code: "refunds.create", label: "Refund" }, { code: "cashier.shift", label: "Cash drawer" },
  ] },
  { id: "back", label: "Menu, stock and customers", perms: [
    { code: "menu.manage", label: "Edit the menu" }, { code: "inventory.manage", label: "Manage stock and recipes" }, { code: "purchases.manage", label: "Purchases and suppliers" },
    { code: "expenses.manage", label: "Expenses" }, { code: "crm.read", label: "See customers" }, { code: "crm.write", label: "Edit customers" },
  ] },
  { id: "reports", label: "Reports and AI", perms: [
    { code: "reports.view", label: "See reports" }, { code: "reports.close_day", label: "Close the day" }, { code: "audit.view", label: "See the audit log" },
    { code: "system.view", label: "See system health" }, { code: "ai.use", label: "Ask AI" },
  ] },
  { id: "admin", label: "Settings and people", perms: [
    { code: "settings.manage", label: "Restaurant settings" }, { code: "settings.owner", label: "Owner-only settings" }, { code: "printing.manage", label: "Set up printers" }, { code: "printing.use", label: "Print bills and tickets" },
    { code: "outlets.manage", label: "Manage outlets" }, { code: "outlets.access_all", label: "Reach every outlet" },
    { code: "staff.view", label: "See staff" }, { code: "staff.create", label: "Add staff" }, { code: "staff.deactivate", label: "Switch accounts off" },
    { code: "staff.reset_password", label: "Reset passwords" }, { code: "staff.manage_roles", label: "Change roles" }, { code: "staff.manage_outlet_access", label: "Choose each person's outlets" },
  ] },
];
const KNOWN = new Set(PERMISSION_GROUPS.flatMap((g) => g.perms.map((p) => p.code)));
export const unknownPerms = (perms: string[]) => perms.filter((p) => !KNOWN.has(p));
export const permLabel = (code: string) => PERMISSION_GROUPS.flatMap((g) => g.perms).find((p) => p.code === code)?.label ?? code;

/** Roles come as an array (system roles first). Anything else is read as "none". */
export function normaliseRoles(raw: unknown): RoleDef[] {
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { items?: unknown })?.items) ? (raw as { items: unknown[] }).items : [];
  return list.filter((r): r is RoleDef => !!r && typeof (r as RoleDef).id === "string" && typeof (r as RoleDef).name === "string")
    .map((r) => ({ ...r, is_system: !!r.is_system, permissions: Array.isArray(r.permissions) ? r.permissions : [] }));
}

/** `null` = the server has no custom-role API. */
export async function loadRoles(): Promise<RoleDef[] | null> {
  try { return normaliseRoles(await api.roles()); }
  catch (e) { if (isUnsupported(e)) return null; throw e; }
}

export interface CatalogueGroup { id: string; label: string; perms: { code: string; label: string; note?: string; grantable: boolean }[] }
/** The server's catalogue (labels in the user's language, `grantable` = the caller holds it); falls back to the built-in list when the route is missing. */
export async function loadCatalogue(lang: "en" | "hi" = "en"): Promise<CatalogueGroup[]> {
  try {
    const c = await api.permissionCatalogue();
    return c.areas.map((a) => ({ id: a.key, label: a.label[lang] ?? a.label.en, perms: a.permissions.map((p) => ({ code: p.key, label: p.label[lang] ?? p.label.en, note: (p.note?.[lang] ?? p.note?.en) || undefined, grantable: p.grantable })) }));
  } catch {
    return PERMISSION_GROUPS.map((g) => ({ id: g.id, label: g.label, perms: g.perms.map((p) => ({ ...p, grantable: true })) }));
  }
}
