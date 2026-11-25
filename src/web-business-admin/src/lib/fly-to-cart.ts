/**
 * "Add to cart" flight: a small ghost (the dish image, or a copper dot) arcs from the tapped element to the cart
 * target, then the target does a little bump. Imperative (Web Animations API): no React state, no layout thrash,
 * never blocks the click handler (the cart update happens immediately; this is decoration).
 *
 *   <button onClick={(e) => { addToCart(item); flyToCart(e.currentTarget, { imageUrl }); }}>
 *   ...the cart button / order panel heading: <span data-cart-target>...</span>
 *
 * With "Reduce effects" / reduced motion, only the target bump plays (or nothing if motion is reduced).
 */
import { effectsAreFull } from "@/components/theme/effects";

function visibleTarget(sel: string): HTMLElement | null {
  const all = Array.from(document.querySelectorAll<HTMLElement>(sel));
  return all.find((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && el.offsetParent !== null; }) ?? null;
}

export function bumpCartTarget(target?: HTMLElement | null) {
  const el = target ?? visibleTarget("[data-cart-target]");
  if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  el.classList.remove("anim-cart-bump"); void el.offsetWidth; el.classList.add("anim-cart-bump");
}

export function flyToCart(from: Element, opts: { imageUrl?: string | null; target?: HTMLElement | string } = {}) {
  if (typeof window === "undefined") return;
  const target = typeof opts.target === "string" ? visibleTarget(opts.target) : opts.target ?? visibleTarget("[data-cart-target]");
  if (!target) return;
  if (!effectsAreFull() || !("animate" in Element.prototype)) { bumpCartTarget(target); return; }

  const a = from.getBoundingClientRect(), b = target.getBoundingClientRect();
  const size = 44;
  const sx = a.left + a.width / 2 - size / 2, sy = a.top + a.height / 2 - size / 2;
  const ex = b.left + b.width / 2 - size / 2, ey = b.top + b.height / 2 - size / 2;
  const ghost = document.createElement("div");
  ghost.setAttribute("aria-hidden", "true");
  Object.assign(ghost.style, {
    position: "fixed", left: "0", top: "0", width: `${size}px`, height: `${size}px`, zIndex: "80", pointerEvents: "none",
    borderRadius: "14px", boxShadow: "var(--shadow-glow)", backgroundColor: "var(--primary-vivid)", backgroundImage: "var(--primary-gradient)",
    backgroundSize: "cover", backgroundPosition: "center", border: "2px solid var(--surface)",
  } satisfies Partial<CSSStyleDeclaration>);
  if (opts.imageUrl) ghost.style.backgroundImage = `url("${opts.imageUrl.replace(/"/g, "%22")}")`;
  document.body.appendChild(ghost);
  // Arc: rise above the straight line, then dive into the cart.
  const mx = (sx + ex) / 2, my = Math.min(sy, ey) - Math.max(60, Math.abs(ex - sx) * 0.18);
  const anim = ghost.animate([
    { transform: `translate(${sx}px, ${sy}px) scale(1)`, opacity: 1 },
    { transform: `translate(${mx}px, ${my}px) scale(.9) rotate(-8deg)`, opacity: 1, offset: 0.45 },
    { transform: `translate(${ex}px, ${ey}px) scale(.35) rotate(0deg)`, opacity: 0.6, offset: 0.9 },
    { transform: `translate(${ex}px, ${ey}px) scale(.2) rotate(0deg)`, opacity: 0 }, // fades out ON the badge: no ghost left over the heading
  ], { duration: 620, easing: "cubic-bezier(.45,0,.25,1)" });
  let gone = false;
  const done = () => { if (gone) return; gone = true; ghost.remove(); bumpCartTarget(target); };
  anim.onfinish = done; anim.oncancel = () => { gone = true; ghost.remove(); };
  // Safety net: a throttled / backgrounded tab may never deliver onfinish; the ghost must not stay over the "Order items" count.
  window.setTimeout(done, 900);
}
