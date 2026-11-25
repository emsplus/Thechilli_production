import { divDecimal, isDecimal, mulDecimal, trimDecimal } from "./decimal";
import { normalizeUnit } from "./units";

/**
 * Pure maths of the helper. new quantity = packs x size; new unit_price = line total / new quantity (4 dp, exact);
 * the line total is kept. Null when an input is not a positive number.
 */
export function convertPack(packs: string, size: string, sizeUnit: string, lineTotal: string): { quantity: string; unit: string; unit_price: string; total: string } | null {
  if (!isDecimal(packs) || !isDecimal(size) || Number(packs) <= 0 || Number(size) <= 0 || !isDecimal(lineTotal)) return null;
  const quantity = mulDecimal(packs, size, 3);
  if (Number(quantity) <= 0) return null;
  const unit_price = divDecimal(lineTotal, quantity, 4);
  if (!unit_price) return null;
  return { quantity: trimDecimal(quantity), unit: normalizeUnit(sizeUnit), unit_price: trimDecimal(unit_price), total: lineTotal };
}
