/**
 * Merged orders (two tables' orders joined into one). The server reports them with kind "merged" and `merged_into_number`
 * (or `merged_into_order_id`); an older server only sends status "cancelled" with the reason "Merged into order <id>".
 * A merged order is NOT a cancellation: Orders shows "Merged" (neutral) with "Merged into order #<number>", never an internal id.
 */
export interface MergeFields {
  kind?: string | null; status?: string; cancel_reason?: string | null;
  merged_into_number?: string | number | null; merged_into_order_id?: string | null; merged_into?: string | null;
}

const REASON = /^\s*merged into order\s+(\S+)/i;

export function isMergedOrder(o: MergeFields): boolean {
  return o.kind === "merged" || o.status === "merged" || o.merged_into_number != null || !!o.merged_into_order_id || !!o.merged_into || REASON.test(o.cancel_reason ?? "");
}

/** The short code an order is known by on screen (first 6 characters of its id, upper case): the same one the Orders card prints as #ABC123. */
export const shortOrderId = (id: string) => id.slice(0, 6).toUpperCase();

/**
 * "Merged into order #12". The number the server sent; else the target order's printed number (found by the id in the reason / field);
 * never the raw id of an order the screen cannot name. `numberOf(id)` looks a target order up.
 */
export function mergedIntoText(o: MergeFields, numberOf?: (id: string) => string | null): string {
  const given = o.merged_into_number;
  if (given != null && String(given).trim() !== "") return `Merged into order #${String(given).replace(/^#/, "")}`;
  const id = o.merged_into_order_id ?? o.merged_into ?? REASON.exec(o.cancel_reason ?? "")?.[1] ?? null;
  const n = id ? numberOf?.(id) ?? shortOrderId(id) : null;
  return n ? `Merged into order #${n.replace(/^#/, "")}` : "Merged into another order";
}
