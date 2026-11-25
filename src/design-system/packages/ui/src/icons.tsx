import type { ReactNode } from 'react';

const p = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false } as const;

export const icons: Record<string, ReactNode> = {
  dot: <svg {...p}><circle cx="8" cy="8" r="3" fill="currentColor" /></svg>,
  clock: <svg {...p}><circle cx="8" cy="8" r="6" /><path d="M8 4.5V8l2.5 1.5" /></svg>,
  flame: <svg {...p}><path d="M8 14a4 4 0 0 0 4-4c0-3-3-4-3-7-2 1.5-5 4-5 7a4 4 0 0 0 4 4z" /></svg>,
  check: <svg {...p}><path d="M3 8.5l3.2 3L13 4.5" /></svg>,
  checks: <svg {...p}><path d="M1.5 8.5l3 3L10 5M7 11.5l.5.5L14 5" /></svg>,
  rupee: <svg {...p}><path d="M4 3h8M4 6h8M4 3c4 0 5 1.5 5 3s-1.5 3-5 3l5 4" /></svg>,
  x: <svg {...p}><path d="M4 4l8 8M12 4l-8 8" /></svg>,
  pencil: <svg {...p}><path d="M3 13l.7-3L10.5 3.2l2.3 2.3L6 12.3z" /></svg>,
  alert: <svg {...p}><path d="M8 2l6.5 11.5h-13z" /><path d="M8 6.5v3M8 11.5v.1" /></svg>,
  offline: <svg {...p}><path d="M2 2l12 12M4 8a6 6 0 0 1 3-1.6M10.5 8.6A6 6 0 0 1 12 10M6 11a3 3 0 0 1 4 0" /></svg>,
  sync: <svg {...p}><path d="M13 5a5.5 5.5 0 0 0-10 1M3 11a5.5 5.5 0 0 0 10-1M3 2v4h4M13 14v-4H9" /></svg>,
  upload: <svg {...p}><path d="M8 11V3M5 6l3-3 3 3M3 13h10" /></svg>,
  info: <svg {...p}><circle cx="8" cy="8" r="6" /><path d="M8 7v4M8 5v.1" /></svg>,
  up: <svg {...p}><path d="M8 13V3M4 7l4-4 4 4" /></svg>,
  down: <svg {...p}><path d="M8 3v10M4 9l4 4 4-4" /></svg>,
  flat: <svg {...p}><path d="M3 8h10" /></svg>,
  pin: <svg {...p}><path d="M8 14s5-4.2 5-8a5 5 0 0 0-10 0c0 3.8 5 8 5 8z" /><circle cx="8" cy="6" r="1.5" /></svg>,
  sort: <svg {...p}><path d="M5 13V3M2.5 5.5L5 3l2.5 2.5M11 3v10M8.5 10.5L11 13l2.5-2.5" /></svg>,
  back: <svg {...p}><path d="M6 3h7v10H6L2 8z" /><path d="M8.5 6l3 4M11.5 6l-3 4" /></svg>,
  mail: <svg {...p}><rect x="2" y="3.5" width="12" height="9" rx="1.5" /><path d="M2.5 4.5L8 9l5.5-4.5" /></svg>,
  lock: <svg {...p}><rect x="3" y="7" width="10" height="7" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></svg>,
  eye: <svg {...p}><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" /></svg>,
  eyeOff: <svg {...p}><path d="M6.6 3.7A6.6 6.6 0 0 1 8 3.5c4 0 6.5 4.5 6.5 4.5a11 11 0 0 1-1.7 2.2M4.2 4.9A11 11 0 0 0 1.5 8S4 12.5 8 12.5a6.3 6.3 0 0 0 3.3-.9M2 2l12 12M6.6 6.6a2 2 0 0 0 2.8 2.8" /></svg>,
  inbox: <svg {...p}><path d="M2 9l2-6h8l2 6v4H2zM2 9h4l1 2h2l1-2h4" /></svg>,
};
