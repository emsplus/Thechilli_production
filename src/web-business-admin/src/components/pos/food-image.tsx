"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import { FoodGlyph, foodKindFor, type FoodKind } from "./food-glyph";

/** Warm tile tint per food kind (tokens --tile-1..6, light values). */
const TINT: Record<FoodKind, 1 | 2 | 3 | 4 | 5 | 6> = {
  coffee: 5, drink: 6, burger: 2, pizza: 1, dessert: 4, salad: 3, rice: 2, noodles: 1, seafood: 6,
  chicken: 1, soup: 1, bakery: 5, breakfast: 2, wrap: 5, grill: 4, plate: 1,
};

export function initialsOf(name: string): string {
  const w = name.trim().split(/\s+/).filter((x) => /[\p{L}\p{N}]/u.test(x));
  if (!w.length) return "·";
  return (w.length === 1 ? w[0].slice(0, 2) : w[0][0] + w[1][0]).toUpperCase();
}

/**
 * Dish image with a designed fallback. Never shows a broken image: the tinted tile (category glyph + initials) is
 * always painted underneath and the photo fades in only once it has actually loaded; on error it stays hidden.
 * Works offline (fallback is inline SVG; photos are cached by the service worker when the image API lands).
 *   <FoodImage src={item.image_url} name={item.name} category={categoryName} className="aspect-[4/3] rounded-xl" />
 *   variant "thumb" = small square (order lines): glyph only, no initials.
 */
export function FoodImage({ src, name, category, kind, variant = "card", className, alt = "" }: {
  src?: string | null;
  name: string;
  category?: string | null;
  /** Override the glyph picked from category / name. */
  kind?: FoodKind;
  variant?: "card" | "thumb";
  className?: string;
  /** Decorative by default (the dish name is printed next to it). */
  alt?: string;
}) {
  const k = kind ?? foodKindFor(category, name);
  const t = TINT[k];
  const thumb = variant === "thumb";
  return (
    <div className={cn("relative isolate overflow-hidden", className)} style={{ background: `var(--tile-${t})`, color: `var(--tile-${t}-fg)` }}>
      {/* Fallback art (no photo yet): a soft tinted tile with a large category glyph, deliberately calm; the name is printed under it. */}
      <div aria-hidden className="absolute inset-0" style={{ background: "radial-gradient(120% 90% at 30% 15%, rgb(255 255 255 / .55), transparent 60%)", mixBlendMode: "soft-light" }} />
      {!thumb && <div aria-hidden className="absolute inset-0 opacity-[0.07]" style={{ backgroundImage: "radial-gradient(currentColor 1px, transparent 1.2px)", backgroundSize: "14px 14px" }} />}
      <div aria-hidden className="absolute inset-0 grid place-items-center">
        <FoodGlyph kind={k} className={thumb ? "size-[58%]" : "size-[56%] max-h-36 max-w-36 drop-shadow-[0_8px_14px_rgb(0_0_0/0.12)]"} />
      </div>
      {src && <Photo key={src} src={src} alt={alt} />}
    </div>
  );
}

/** Keyed by src, so a new URL starts hidden again. Removed from the DOM on error (no broken-image glyph, ever). */
function Photo({ src, alt }: { src: string; alt: string }) {
  const [state, setState] = useState<"loading" | "ok" | "failed">("loading");
  if (state === "failed") return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- API-hosted user photos; next/image would need remotePatterns + server optimisation (not available offline).
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      draggable={false}
      onLoad={() => setState("ok")}
      onError={() => setState("failed")}
      className={cn("absolute inset-0 size-full object-cover transition-opacity duration-300", state === "ok" ? "opacity-100" : "opacity-0")}
    />
  );
}
