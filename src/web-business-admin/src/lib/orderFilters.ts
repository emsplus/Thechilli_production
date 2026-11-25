import { isMergedOrder, type MergeFields } from "./mergedOrders";

/**
 * Orders page filter chips. "All" is every order there is (cancelled, voided and merged too). The other chips never overlap, so their
 * counts add up to All: Open (not sent yet), In kitchen, Awaiting payment, Paid, Cancelled & voided, Merged.
 * A merged order is not a cancellation: it has its own chip and never counts under Cancelled.
 */
export type OrderGroup = "open" | "kitchen" | "unpaid" | "paid" | "cancelled" | "merged";
export type OrderFilter = "all" | OrderGroup;

export const ORDER_FILTERS: { value: OrderFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "kitchen", label: "In kitchen" },
  { value: "unpaid", label: "Awaiting payment" },
  { value: "paid", label: "Paid" },
  { value: "cancelled", label: "Cancelled & voided" },
  { value: "merged", label: "Merged" },
];

interface O extends MergeFields { id: string; status: string; created_at?: string | null }
interface B { status?: string; balance_due: string }

/** The one chip an order belongs to. */
export function groupOf(o: O, bill?: B, inKitchen = false): OrderGroup {
  if (isMergedOrder(o)) return "merged";
  if (o.status === "cancelled" || bill?.status === "voided") return "cancelled";
  if (o.status === "sent_to_kitchen") return "kitchen";
  if (o.status === "open") return inKitchen ? "kitchen" : "open";
  if (o.status === "billed") return bill && Number(bill.balance_due) === 0 ? "paid" : "unpaid";
  return "open";
}
/** Kept for callers that ask for a list. */
export const groupsOf = (o: O, bill?: B, inKitchen = false): OrderGroup[] => [groupOf(o, bill, inKitchen)];

// Running work first, then paid, then the ones that ended without a sale (cancelled, merged).
const rank = (g: OrderGroup) => (g === "paid" ? 1 : g === "cancelled" || g === "merged" ? 2 : 0);
const time = (o: O) => (o.created_at ? Date.parse(o.created_at) || 0 : 0);

/** Orders for a chip, running first, then paid, then cancelled / merged, newest first inside each. "all" keeps every order. */
export function filterOrders<T extends O>(orders: T[], billOf: (o: T) => B | undefined, f: OrderFilter, kitchenIds?: ReadonlySet<string>): T[] {
  const withG = orders.map((o) => ({ o, g: groupOf(o, billOf(o), kitchenIds?.has(o.id) ?? false) }));
  const keep = withG.filter(({ g }) => f === "all" || g === f);
  return keep.sort((a, b) => rank(a.g) - rank(b.g) || time(b.o) - time(a.o)).map((x) => x.o);
}

/** `kitchenIds`: orders the kitchen really has (lib/kitchenActive), the same rule as the Kitchen board; without it only the order status counts. */
export function countOrders<T extends O>(orders: T[], billOf: (o: T) => B | undefined, kitchenIds?: ReadonlySet<string>): Record<OrderFilter, number> {
  const c: Record<OrderFilter, number> = { all: 0, open: 0, kitchen: 0, unpaid: 0, paid: 0, cancelled: 0, merged: 0 };
  for (const o of orders) { c.all++; c[groupOf(o, billOf(o), kitchenIds?.has(o.id) ?? false)]++; }
  return c;
}

/** A made bill that still has a balance and has not been voided or replaced: the Orders list offers "Take payment" on it. */
export function billAwaitsPayment(bill: { status?: string; balance_due: string } | undefined | null): boolean {
  return !!bill && bill.status !== "voided" && bill.status !== "superseded" && Number(bill.balance_due) > 0;
}

/** An order with no bill that is still running (open or in the kitchen): the Orders list offers "Make bill" on it. */
export function orderCanBeBilled(o: { status: string } & MergeFields, bill?: { status?: string } | null): boolean {
  return !bill && !isMergedOrder(o) && (o.status === "open" || o.status === "sent_to_kitchen");
}
