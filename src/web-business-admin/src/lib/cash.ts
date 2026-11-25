import { cmpMoney, sumMoney } from "./money";

/** counted - expected, exact (negative = short). Both are Decimal strings. */
export const cashVariance = (counted: string, expected: string) => sumMoney([counted, sumMoney([`-${expected}`])]);
/** The server needs a reason (3-300 characters) for any non-zero variance. */
export const needsVarianceReason = (counted: string, expected: string) => cmpMoney(cashVariance(counted, expected), 0) !== 0;
/** A money amount the cashier may type: digits with up to 2 decimals. */
export const validAmount = (s: string) => /^\d{1,9}(\.\d{1,2})?$/.test(s.trim());
