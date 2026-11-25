"use client";

/** Tiny trend line (decorative; the numbers are shown elsewhere). */
export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  if (values.length < 2) return null;
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const W = 80, H = 24;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * (W - 4) + 2, H - 3 - ((v - min) / span) * (H - 6)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  const last = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={className ?? "h-6 w-20"} aria-hidden>
      <path d={`${line}L${last[0]},${H}L${pts[0][0]},${H}Z`} fill="var(--viz-seq)" opacity={0.1} />
      <path d={line} fill="none" stroke="var(--viz-seq)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r={3} fill="var(--viz-seq)" stroke="var(--surface)" strokeWidth={2} />
    </svg>
  );
}
