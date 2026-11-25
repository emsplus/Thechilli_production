import type { MenuItem } from "./types";

/**
 * The option (Half / Full) of an order line, from the line's variant id and the menu snapshot (the order stores only the id; a line
 * made on this phone also carries the name). "" when the dish has no options or the option is not on the menu any more.
 */
export function variantNameOf(items: MenuItem[] | undefined, itemId: string, variantId: string | null | undefined, known?: string | null): string {
  if (known) return known;
  if (!variantId) return "";
  return items?.find((i) => i.id === itemId)?.variants.find((v) => v.id === variantId)?.name ?? "";
}

/** True when the dish name already says the option ("Butter Chicken (Half)": the server writes that on a defaulted line). */
export const nameSaysVariant = (name: string, variant: string): boolean => !!variant && name.toLowerCase().includes(variant.toLowerCase());

/** The name to show for a line: "Butter Chicken · Half". Never twice, never without the option when the line has one. */
export function lineTitle(name: string, variant: string): string {
  return variant && !nameSaysVariant(name, variant) ? `${name} · ${variant}` : name;
}
