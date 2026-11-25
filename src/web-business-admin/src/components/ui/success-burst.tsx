"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffectsLevel } from "@/components/theme/effects";

const COLORS = ["var(--c-primary)", "var(--c-accent)", "var(--c-chilli-200)", "var(--success)", "var(--c-ink)"];
const N = 14;
const PARTS = Array.from({ length: N }, (_, i) => {
  const a = (i / N) * Math.PI * 2 + (i % 2 ? 0.2 : 0);
  const r = 46 + (i % 3) * 14;
  return { x: Math.cos(a) * r, y: Math.sin(a) * r, c: COLORS[i % COLORS.length], s: i % 3 === 0 ? 8 : 6, rot: i % 2 ? 45 : 0, round: i % 3 !== 0 };
});

/**
 * Confetti-style burst for a completed payment / order. Re-fires whenever `trigger` changes (pass a counter or
 * an id; null/undefined = idle). Decorative (aria-hidden); announce success with text. Nothing under reduced effects.
 *   <div className="relative"><SuccessCheckIllustration /><SuccessBurst trigger={paidId} /></div>
 */
export function SuccessBurst({ trigger, className }: { trigger: string | number | null | undefined; className?: string }) {
  const { level } = useEffectsLevel();
  if (level !== "full") return null;
  return (
    <span aria-hidden className={className ?? "pointer-events-none absolute left-1/2 top-1/2 size-0"}>
      <AnimatePresence>
        {trigger != null && (
          <motion.span key={String(trigger)} className="absolute" initial="a" animate="b" exit={{ opacity: 0 }}>
            {PARTS.map((p, i) => (
              <motion.span key={i}
                className="absolute block"
                style={{ width: p.s, height: p.s, marginLeft: -p.s / 2, marginTop: -p.s / 2, background: p.c, borderRadius: p.round ? 999 : 2 }}
                variants={{ a: { x: 0, y: 0, scale: 0, opacity: 1, rotate: 0 }, b: { x: p.x, y: p.y, scale: [0, 1.2, 0.9], opacity: [1, 1, 0], rotate: p.rot + 90 } }}
                transition={{ duration: 0.75, ease: [0.22, 1, 0.36, 1], delay: (i % 4) * 0.015 }} />
            ))}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}
