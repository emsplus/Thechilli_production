import { cmpMoney } from "./money";

/**
 * Cost of goods is "not known" when nothing has a recipe or cost: ingredient cost 0 while there are sales. A margin computed from
 * that (100%) is misleading, so screens say "Add recipe costs to see profit" instead. A server flag `cost_known: false` also counts.
 */
export function costKnown(p: { ingredient_cost?: string | null; revenue_excl_vat?: string | null; net_sales_excl_vat?: string | null; cost_known?: boolean | null }): boolean {
  if (p.cost_known === false) return false;
  const sales = p.revenue_excl_vat ?? p.net_sales_excl_vat ?? "0";
  return !(cmpMoney(p.ingredient_cost ?? "0", 0) === 0 && cmpMoney(sales, 0) > 0);
}

export const RECIPES_HREF = "/manage?tab=recipes";
export const ADD_COSTS_TEXT = "Add recipe costs to see profit";
