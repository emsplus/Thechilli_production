import type { OrderType } from "./types";

/**
 * Where an order is, in words. The server derives an order's type from its table's area, so on every screen a table order says
 * "Table AC1 · Indoor" (the table's own area), never a type taken from somewhere else that could say Dine-in on one screen
 * and Outdoor on another for the same table. Orders without a table say Takeaway / Delivery.
 */
export const AREA_LABEL: Record<"indoor" | "outdoor", string> = { indoor: "Indoor", outdoor: "Outdoor" };

/** "Indoor" / "Outdoor" for a table area; null for anything else (takeaway, delivery, unknown). */
export const areaLabel = (area: string | null | undefined): string | null =>
  area === "indoor" || area === "outdoor" ? AREA_LABEL[area] : null;

export interface TableLike { label: string; area?: string | null }

/** "Table AC1 · Indoor" (area unknown: "Table AC1"). */
export function tableWhere(table: TableLike): string {
  const a = areaLabel(table.area);
  return a ? `Table ${table.label} · ${a}` : `Table ${table.label}`;
}

/**
 * The line for an order: its table with the table's area, or Takeaway / Delivery. A table order whose table is not in the loaded
 * list says just "Table" (never the order's own type, which could contradict the table). `fallbackTableLabel` = a label the
 * server already printed on the bill.
 */
export function orderWhere(o: { order_type?: OrderType | string | null; table_id?: string | null }, table?: TableLike | null, fallbackTableLabel?: string | null): string {
  if (table) return tableWhere(table);
  if (o.table_id || fallbackTableLabel) return fallbackTableLabel ? `Table ${fallbackTableLabel}` : "Table";
  return o.order_type === "takeaway" ? "Takeaway" : o.order_type === "delivery" ? "Delivery" : "No table";
}

/** The area to draw an order's icon from: the table's own, else the order's type. */
export const orderArea = (o: { order_type?: string | null }, table?: TableLike | null): string | null | undefined => table?.area ?? o.order_type;
