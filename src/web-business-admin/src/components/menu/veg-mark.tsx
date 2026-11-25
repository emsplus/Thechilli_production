import { cn } from "@/lib/cn";
import { FOOD_LABEL, type FoodKind } from "@/lib/menuAdmin";

/**
 * The FSSAI food mark (style guide v1.0): a square outline in the mark colour with a round dot (veg, green), a triangle
 * (non-veg, red-brown) or an upright oval (egg, orange). Shape AND colour, so it never relies on colour alone, plus the
 * word for screen readers (and as a tooltip). `label` overrides the spoken word (e.g. a translated one);
 * `decorative` hides it from screen readers when the word is already visible next to it.
 */
export function VegMark({ kind, label, decorative, className }: { kind: FoodKind; label?: string; decorative?: boolean; className?: string }) {
  const text = label ?? FOOD_LABEL[kind];
  const color = kind === "veg" ? "var(--c-veg)" : kind === "egg" ? "var(--c-egg)" : "var(--c-non-veg)";
  return (
    <span data-food={kind} aria-hidden={decorative || undefined} className={cn("inline-grid size-4 shrink-0 place-items-center rounded-[3px] border-2 bg-surface", className)} style={{ borderColor: color }} title={decorative ? undefined : text}>
      <span aria-hidden className={kind === "veg" ? "size-1.5 rounded-full" : kind === "egg" ? "h-2 w-[5px] rounded-[50%]" : "size-0 border-x-[4px] border-b-[7px] border-x-transparent"}
        style={kind === "nonveg" ? { borderBottomColor: color } : { background: color }} />
      {!decorative && <span className="sr-only">{text}</span>}
    </span>
  );
}
