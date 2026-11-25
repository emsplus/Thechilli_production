import { cn } from "@/lib/cn";

/**
 * Original two-tone food glyphs (48x48) for image fallbacks, category pills and empty states. They draw with
 * currentColor at several opacities, so they take the tile's foreground colour in both themes.
 */
export type FoodKind =
  | "coffee" | "drink" | "burger" | "pizza" | "dessert" | "salad" | "rice" | "noodles" | "seafood"
  | "chicken" | "soup" | "bakery" | "breakfast" | "wrap" | "grill" | "plate";

const RULES: [FoodKind, RegExp][] = [
  ["coffee", /hot drink|coffee|latte|espresso|cappuccino|mocha|americano|flat white|macchiato|karak|chai|\btea\b|cortado/i],
  ["drink", /drink|beverage|juice|shake|smoothie|soda|cola|lemonade|mojito|water|mocktail|lassi|frapp|iced|bevar/i],
  ["burger", /burger|slider/i],
  ["pizza", /pizza|flatbread|manakeesh|manakish/i],
  ["dessert", /dessert|cake|sweet|ice ?cream|kunafa|knafeh|brownie|cookie|pudding|waffle|pancake|donut|doughnut|cheesecake|baklava|umm ali|gelato|tart/i],
  ["salad", /salad|veg|vegan|fattoush|tabbouleh|greens|bowl/i],
  ["noodles", /noodle|ramen|pasta|spaghetti|udon|lo mein|chow/i],
  ["rice", /rice|biryani|mandi|machboos|majboos|pilaf|risotto|kabsa|fried rice|sushi/i],
  ["seafood", /sea ?food|fish|shrimp|prawn|salmon|tuna|lobster|crab|hammour|calamari|squid|scallop/i],
  ["chicken", /chicken|wing|nugget|tender|drumstick|broast/i],
  ["soup", /soup|lentil|harira|broth|stew|curry|shorba/i],
  ["bakery", /bak|bread|croissant|pastr|muffin|bun|sandwich|toast|bagel|samosa|fatayer/i],
  ["breakfast", /breakfast|egg|omelet|shakshuka|brunch|foul|ful medames/i],
  ["wrap", /wrap|shawarma|roll|burrito|taco|kathi|falafel/i],
  ["grill", /grill|bbq|kebab|kabab|steak|tikka|meat|lamb|beef|mixed grill|shish|kofta|ribs/i],
];

/** Picks a glyph from the category name first, then the dish name. */
export function foodKindFor(...hints: (string | null | undefined)[]): FoodKind {
  for (const h of hints) {
    if (!h) continue;
    for (const [k, re] of RULES) if (re.test(h)) return k;
  }
  return "plate";
}

export function FoodGlyph({ kind, className }: { kind: FoodKind; className?: string }) {
  return (
    <svg viewBox="0 0 48 48" fill="none" aria-hidden className={cn("size-6 shrink-0", className)}>
      {GLYPHS[kind]}
    </svg>
  );
}

const C = "currentColor";
const GLYPHS: Record<FoodKind, React.ReactNode> = {
  coffee: (<>
    <path d="M17 6c-2 3 2 4 0 7M24 5c-2 3 2 4 0 7" stroke={C} strokeWidth="2.4" strokeLinecap="round" opacity=".45" />
    <path d="M9 18h26v9a13 13 0 0 1-13 13h0A13 13 0 0 1 9 27z" fill={C} opacity=".9" />
    <path d="M35 21h2.5a5 5 0 0 1 0 10H34" stroke={C} strokeWidth="3" opacity=".9" />
    <path d="M13 22h8" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" opacity=".5" />
    <ellipse cx="22" cy="43" rx="15" ry="2.5" fill={C} opacity=".2" />
  </>),
  drink: (<>
    <path d="M28 4l-4 12" stroke={C} strokeWidth="2.6" strokeLinecap="round" opacity=".6" />
    <path d="M12 14h24l-3 28H15z" fill={C} opacity=".3" />
    <path d="M13.3 24h21.4L33 42H15z" fill={C} opacity=".9" />
    <circle cx="35" cy="14" r="5" fill={C} opacity=".55" />
    <path d="M17 28v9" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" opacity=".5" />
  </>),
  burger: (<>
    <path d="M7 21a17 13 0 0 1 34 0z" fill={C} opacity=".9" />
    <path d="M15 14l1.5 1M24 12v1.6M32 14l-1.5 1" stroke="#fff" strokeWidth="2" strokeLinecap="round" opacity=".6" />
    <path d="M6 25.5c3-2 6 2 9 0s6 2 9 0 6 2 9 0 6 2 9 0" stroke={C} strokeWidth="3" strokeLinecap="round" opacity=".5" />
    <rect x="6" y="28" width="36" height="5" rx="2.5" fill={C} opacity=".7" />
    <path d="M8 36h32a0 0 0 0 1 0 0 5 5 0 0 1-5 5H13a5 5 0 0 1-5-5z" fill={C} opacity=".9" />
  </>),
  pizza: (<>
    <path d="M24 44L6 12a30 30 0 0 1 36 0z" fill={C} opacity=".35" />
    <path d="M24 44L9.6 18.5a25 25 0 0 1 28.8 0z" fill={C} opacity=".85" />
    <path d="M6 12a30 30 0 0 1 36 0" stroke={C} strokeWidth="4" strokeLinecap="round" opacity=".55" />
    <circle cx="19" cy="23" r="3" fill="#fff" opacity=".55" /><circle cx="28" cy="22" r="2.6" fill="#fff" opacity=".55" /><circle cx="24" cy="32" r="2.6" fill="#fff" opacity=".55" />
  </>),
  dessert: (<>
    <path d="M8 22L38 12l2 10z" fill={C} opacity=".45" />
    <rect x="8" y="22" width="32" height="18" rx="3" fill={C} opacity=".9" />
    <path d="M8 29c4 3 8-2 12 1s8-2 12 1 6 0 8-1" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" opacity=".55" />
    <circle cx="33" cy="9" r="4" fill={C} opacity=".7" /><path d="M33 5c1-2 3-3 4-3" stroke={C} strokeWidth="2" strokeLinecap="round" opacity=".7" />
  </>),
  salad: (<>
    <circle cx="16" cy="17" r="7" fill={C} opacity=".45" /><circle cx="26" cy="13" r="7" fill={C} opacity=".6" /><circle cx="34" cy="19" r="6" fill={C} opacity=".45" />
    <circle cx="22" cy="20" r="3" fill="#fff" opacity=".45" />
    <path d="M5 22h38a19 19 0 0 1-19 19A19 19 0 0 1 5 22z" fill={C} opacity=".9" />
    <path d="M11 27a13 13 0 0 0 6 7" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" opacity=".5" />
  </>),
  rice: (<>
    <path d="M30 4L20 18M38 6L26 19" stroke={C} strokeWidth="2.4" strokeLinecap="round" opacity=".55" />
    <path d="M9 21a15 9 0 0 1 30 0z" fill={C} opacity=".4" />
    <circle cx="17" cy="17" r="1.4" fill="#fff" opacity=".7" /><circle cx="23" cy="15" r="1.4" fill="#fff" opacity=".7" /><circle cx="29" cy="17" r="1.4" fill="#fff" opacity=".7" />
    <path d="M5 22h38a19 19 0 0 1-19 19A19 19 0 0 1 5 22z" fill={C} opacity=".9" />
    <path d="M12 30h24" stroke="#fff" strokeWidth="2" strokeLinecap="round" opacity=".35" />
  </>),
  noodles: (<>
    <path d="M14 20c0-6 4-6 4-12M20 20c0-6 4-6 4-12M26 20c0-6 4-6 4-12" stroke={C} strokeWidth="2.6" strokeLinecap="round" opacity=".5" />
    <path d="M34 4l-2 17" stroke={C} strokeWidth="2.6" strokeLinecap="round" opacity=".8" />
    <path d="M5 22h38a19 19 0 0 1-19 19A19 19 0 0 1 5 22z" fill={C} opacity=".9" />
    <path d="M12 28a12 12 0 0 0 5 6" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" opacity=".5" />
  </>),
  seafood: (<>
    <path d="M4 24c6-9 18-12 28-6l8-6v24l-8-6C22 36 10 33 4 24z" fill={C} opacity=".9" />
    <circle cx="13" cy="22" r="2.2" fill="#fff" opacity=".75" />
    <path d="M20 17c2 4 2 10 0 14M26 18c1.5 4 1.5 8 0 12" stroke="#fff" strokeWidth="2" strokeLinecap="round" opacity=".4" />
    <ellipse cx="24" cy="43" rx="14" ry="2.5" fill={C} opacity=".2" />
  </>),
  chicken: (<>
    <path d="M29 7c8 0 13 7 11 14-2 8-11 10-17 6-5-4-3-20 6-20z" fill={C} opacity=".9" />
    <path d="M23 27L13 37" stroke={C} strokeWidth="5" strokeLinecap="round" opacity=".55" />
    <circle cx="10.5" cy="39.5" r="3.6" fill={C} opacity=".55" /><circle cx="14" cy="42" r="3" fill={C} opacity=".55" />
    <path d="M31 12c3 1 5 3 5 6" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" opacity=".5" />
  </>),
  soup: (<>
    <path d="M17 6c-2 3 2 4 0 7M24 4c-2 3 2 4 0 7M31 6c-2 3 2 4 0 7" stroke={C} strokeWidth="2.4" strokeLinecap="round" opacity=".45" />
    <path d="M5 19h38a19 19 0 0 1-19 19A19 19 0 0 1 5 19z" fill={C} opacity=".9" />
    <rect x="15" y="39" width="18" height="4" rx="2" fill={C} opacity=".6" />
    <path d="M11 24a13 13 0 0 0 6 7" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" opacity=".5" />
  </>),
  bakery: (<>
    <path d="M6 30c0-12 8-20 18-20s18 8 18 20c0 4-3 6-6 6H12c-3 0-6-2-6-6z" fill={C} opacity=".9" />
    <path d="M17 13c-1 6-1 14 1 22M24 10v26M31 13c1 6 1 14-1 22" stroke="#fff" strokeWidth="2" strokeLinecap="round" opacity=".4" />
    <ellipse cx="24" cy="42" rx="15" ry="2.5" fill={C} opacity=".2" />
  </>),
  breakfast: (<>
    <circle cx="24" cy="25" r="18" fill={C} opacity=".3" />
    <path d="M13 22c0-7 7-11 13-9 7 2 11 6 9 13-2 6-9 8-15 6-5-1-7-5-7-10z" fill="#fff" opacity=".85" />
    <circle cx="24" cy="23" r="5.5" fill={C} opacity=".95" />
    <circle cx="22.5" cy="21.5" r="1.6" fill="#fff" opacity=".6" />
  </>),
  wrap: (<>
    <path d="M14 8l20 6-8 30-14-4z" fill={C} opacity=".9" />
    <path d="M14 8l20 6-3 10-19-6z" fill={C} opacity=".45" />
    <path d="M16 12c3 0 6 3 9 2s5 1 7 3" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" opacity=".55" />
    <path d="M18 26l9 3M17 32l8 2" stroke="#fff" strokeWidth="2" strokeLinecap="round" opacity=".35" />
  </>),
  grill: (<>
    <path d="M8 40L40 8" stroke={C} strokeWidth="2.6" strokeLinecap="round" opacity=".55" />
    <rect x="12" y="24" width="10" height="10" rx="3" transform="rotate(-45 17 29)" fill={C} opacity=".9" />
    <rect x="20" y="16" width="10" height="10" rx="3" transform="rotate(-45 25 21)" fill={C} opacity=".6" />
    <rect x="28" y="8" width="10" height="10" rx="3" transform="rotate(-45 33 13)" fill={C} opacity=".9" />
    <path d="M14 29l3-3M30 13l3-3" stroke="#fff" strokeWidth="2" strokeLinecap="round" opacity=".5" />
  </>),
  plate: (<>
    <circle cx="24" cy="10" r="2.6" fill={C} opacity=".9" />
    <path d="M8 32a16 16 0 0 1 32 0z" fill={C} opacity=".9" />
    <path d="M14 28a10 10 0 0 1 7-9" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" opacity=".5" />
    <rect x="4" y="34" width="40" height="5" rx="2.5" fill={C} opacity=".6" />
  </>),
};
