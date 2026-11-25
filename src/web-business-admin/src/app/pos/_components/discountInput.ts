import { cmpMoney } from "@/lib/money";

const NUM = /^\d+(\.\d{1,2})?$/;

/**
 * What is wrong with the typed discount value, in words that match the mistake (QA D06: "1e1" and "10.555" both said "greater than
 * zero"). null = a usable number (the 100 % / bill-total limits are checked by the dialog). Empty and whitespace-only are the same case.
 */
export function discountValueError(raw: string): string | null {
  const v = raw.trim();
  if (v === "") return "Enter the discount, e.g. 10 or 2.50";
  if (/^\d+\.\d{3,}$/.test(v)) return "Use at most 2 decimal places, e.g. 2.50";
  if (!NUM.test(v)) return "Use digits only, e.g. 10 or 2.50";
  if (cmpMoney(v, 0) <= 0) return "Enter an amount greater than zero, e.g. 10 or 2.50";
  return null;
}
