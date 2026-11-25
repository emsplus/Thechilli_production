/**
 * Motion system (docs/ui-art-direction.md §5). Import presets instead of hand-tuning numbers per page:
 *   import { spring, fadeUp, stagger, listItem, press, hoverLift, reveal } from "@/lib/motion";
 *   <motion.ul variants={stagger()} initial="hidden" animate="show">
 *     <motion.li variants={fadeUp} />
 *   </motion.ul>
 * Everything is neutralised by <MotionConfig reducedMotion> (Providers): "user" normally, "always" when the
 * "Reduce effects" setting is on. Transforms then snap; opacity still fades (never leaves content hidden).
 */
import type { Transition, Variants } from "motion/react";

export const EASE_OUT = [0.22, 1, 0.36, 1] as const;
export const EASE_IN = [0.4, 0, 1, 1] as const;

/** Durations (seconds). press 0.12 / hover 0.18 / enter 0.26 / exit 0.16 / page 0.26 / celebrate 0.6 */
export const dur = { press: 0.12, hover: 0.18, enter: 0.26, exit: 0.16, page: 0.26, celebrate: 0.6 } as const;

/** Named springs. */
export const spring = {
  /** Buttons, steppers, toggles: fast, no visible overshoot. */
  snappy: { type: "spring", stiffness: 520, damping: 34, mass: 0.7 },
  /** Cards, panels, sheets entering. */
  gentle: { type: "spring", stiffness: 260, damping: 28, mass: 0.9 },
  /** Playful feedback: add-to-cart badge, success tick. Small overshoot. */
  bouncy: { type: "spring", stiffness: 420, damping: 16, mass: 0.7 },
  /** Shared-layout indicators (active nav, pill tabs, segmented control) and list reorder. */
  layout: { type: "spring", stiffness: 420, damping: 36, mass: 0.8 },
} satisfies Record<string, Transition>;

export const tween = {
  enter: { duration: dur.enter, ease: EASE_OUT },
  exit: { duration: dur.exit, ease: EASE_IN },
  fade: { duration: dur.hover, ease: EASE_OUT },
} satisfies Record<string, Transition>;

/* ---- enter / exit variants (use with initial="hidden" animate="show" exit="exit") ---- */
export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: tween.fade },
  exit: { opacity: 0, transition: tween.exit },
};
export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: spring.gentle },
  exit: { opacity: 0, y: -6, transition: tween.exit },
};
export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.94 },
  show: { opacity: 1, scale: 1, transition: spring.gentle },
  exit: { opacity: 0, scale: 0.97, transition: tween.exit },
};
export const popIn: Variants = {
  hidden: { opacity: 0, scale: 0.6 },
  show: { opacity: 1, scale: 1, transition: spring.bouncy },
  exit: { opacity: 0, scale: 0.8, transition: tween.exit },
};
/** Order lines / list rows: slide in from the right, collapse height on exit. Wrap in <AnimatePresence initial={false}>. */
export const listItem: Variants = {
  hidden: { opacity: 0, x: 16, height: 0 },
  show: { opacity: 1, x: 0, height: "auto", transition: { ...spring.gentle, opacity: tween.fade } },
  exit: { opacity: 0, x: -12, height: 0, transition: { duration: 0.2, ease: EASE_IN } },
};

/** Stagger container. */
export function stagger(each = 0.04, delay = 0): Variants {
  return { hidden: {}, show: { transition: { staggerChildren: each, delayChildren: delay } }, exit: { transition: { staggerChildren: each / 2, staggerDirection: -1 } } };
}

/* ---- micro-interaction props (spread onto motion.* elements) ---- */
export const press = { whileTap: { scale: 0.97 }, transition: spring.snappy } as const;
export const pressSoft = { whileTap: { scale: 0.985 }, transition: spring.snappy } as const;
export const hoverLift = { whileHover: { y: -3 }, whileTap: { scale: 0.985, y: 0 }, transition: spring.snappy } as const;

/** Scroll-linked reveal for dashboard sections: <motion.section {...reveal}> */
export const reveal = {
  initial: "hidden",
  whileInView: "show",
  viewport: { once: true, amount: 0.2, margin: "0px 0px -40px 0px" },
  variants: fadeUp,
} as const;

/** Shared-layout transition for layoutId indicators. */
export const layoutTransition = spring.layout;
