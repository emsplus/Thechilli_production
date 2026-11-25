import { resolveTheme, type Density, type ThemePreference } from '@chilli/tokens';

export function setDensity(d: Density, root: HTMLElement = document.documentElement): void {
  root.dataset.density = d;
}

/**
 * Applies the theme. Light-only (THEME_LIGHT_ONLY in @chilli/tokens): whatever is asked for, `data-theme="light"` is set and any
 * stored preference is ignored. The `theme` argument is kept so callers need no change when dark mode comes back.
 */
export function setTheme(theme: ThemePreference = 'system', root: HTMLElement = document.documentElement): void {
  const systemDark = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = resolveTheme(theme, systemDark);
}

/** Strategy 4.4: touch on coarse pointers or narrow screens, compact for fine pointers >= 1024px. */
export function autoDensity(win: Window = window): Density {
  const coarse = win.matchMedia('(pointer: coarse)').matches;
  return coarse || win.innerWidth < 1024 ? 'touch' : 'compact';
}

/** Low-end auto-detection (<= 4 cores or <= 4 GB): callers set data-motion="off". */
export function isLowEndDevice(nav: Navigator & { deviceMemory?: number } = navigator): boolean {
  return (nav.hardwareConcurrency ?? 8) <= 4 || (nav.deviceMemory ?? 8) <= 4;
}
