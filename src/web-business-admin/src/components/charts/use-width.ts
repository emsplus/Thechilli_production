"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";

/** Measures an element's content width (px) with ResizeObserver; 0 until mounted. */
export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  const set = useCallback((el: T | null) => { ref.current = el; }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [set, w] as const;
}

/** "Nice" axis ticks covering [min, max] (always includes 0). */
export function niceTicks(min: number, max: number, count = 4): number[] {
  const lo = Math.min(0, min), hi = Math.max(0, max);
  if (hi === lo) return [0, 1];
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.floor(lo / step) * step; v < hi + step * 0.999; v += step) { out.push(Math.round(v * 1e6) / 1e6); if (out[out.length - 1] >= hi) break; }
  return out;
}

export function compact(n: number): string {
  const a = Math.abs(n);
  // Indian units, same words as formatCompactMoney: crore and lakh (never "M"), thousands as K.
  if (a >= 10_000_000) return `${+(n / 10_000_000).toFixed(1)} Cr`;
  if (a >= 100_000) return `${+(n / 100_000).toFixed(1)} L`;
  if (a >= 1000) return `${+(n / 1000).toFixed(1)}K`;
  return String(+n.toFixed(2));
}

/** Geometry only: plot values may be approximated as numbers; exact figures always come from the tables. */
export const num = (v: string | number | null | undefined) => { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; };
