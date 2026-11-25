import { cmpMoney, sumMoney } from "@/lib/money";
import type { PaymentMethod } from "@/lib/types";

/** What the cashier can pick. UPI is booked as the server's "upi" method (pos-service phase1/integration has it). A build against an
 * older server without UPI sets NEXT_PUBLIC_API_HAS_UPI=0 and UPI is then booked as "other"; the UI says UPI either way. */
export const UPI_NATIVE = process.env.NEXT_PUBLIC_API_HAS_UPI !== "0";
export type TenderKind = "cash" | "card" | "upi";
export const API_METHOD: Record<TenderKind, PaymentMethod> = { cash: "cash", card: "card", upi: UPI_NATIVE ? "upi" : "other" };

export interface PayLine { kind: TenderKind; /** Amount applied to the bill. */ amount: string; /** Cash handed over (cash lines only). */ tendered?: string; key: string }

const neg = (v: string) => sumMoney([`-${v}`]);
export const sub = (a: string, b: string) => sumMoney([a, neg(b)]);

/** An amount the keypad may produce: digits with up to 2 decimals. */
export const validEntry = (s: string) => /^\d{0,9}(\.\d{0,2})?$/.test(s);

export interface PayPlan {
  /** Balance left after the lines already added. */
  remaining: string;
  /** What this entry settles (never more than remaining). */
  applied: string;
  /** Cash only: what is handed back. "0.00" otherwise. */
  change: string;
  /** The entry can be added as a split line: more than 0 and less than remaining. */
  canSplit: boolean;
  /** Entry (plus lines) settles the bill exactly. */
  canConfirm: boolean;
}

/** Pure arithmetic of the pay sheet (BigInt-backed strings, no floats). Cash over the remaining gives change; card / UPI cannot exceed it. */
export function planPayment(balance: string, lines: PayLine[], kind: TenderKind, entry: string): PayPlan {
  const remaining = sub(balance, sumMoney(lines.map((l) => l.amount)));
  const e = entry === "" || entry === "." ? "0" : entry;
  const positive = cmpMoney(e, 0) > 0;
  const over = cmpMoney(e, remaining) > 0;
  const rem0 = cmpMoney(remaining, 0) <= 0;
  const applied = !positive ? "0.00" : over ? sumMoney([remaining]) : sumMoney([e]);
  const change = kind === "cash" && over ? sub(e, remaining) : "0.00";
  const covers = positive && !over ? cmpMoney(e, remaining) === 0 : positive && over && kind === "cash";
  return {
    remaining: sumMoney([remaining]),
    applied,
    change,
    canSplit: !rem0 && positive && !over && cmpMoney(e, remaining) < 0,
    canConfirm: rem0 ? lines.length > 0 : covers,
  };
}
