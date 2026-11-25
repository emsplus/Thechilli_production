/** Chilli design tokens. Source of truth; CSS is generated from this file. */

/**
 * TheChilli.ai design system v1.0, final (owner's "TheChilli.ai — Style Guide (1) (1).pdf", 2026-10-31). Supersedes the earlier
 * Quicksand/#E14B00 guide and the BRAND.md summary where they differ.
 * Chilli Red 600 #E50914: wordmark "chilli", primary buttons (white label 4.8:1). 700 #C20710: hover and links (6.3:1).
 * Dark Charcoal #111820 neutrals for surfaces, borders and text (400 and lighter never text). Vibrant Orange #FF5A1F: wordmark dot,
 * badges, chart accents, numbers on dark (3.1:1 on white: never small text on white). Leaf Green #167D32: the stem and success.
 * Danger #B91C1C is close to brand red, so it always comes with an icon and a confirm step.
 * Ratio on a typical screen: canvas + surface 70%, borders 18%, ink 8%, chilli 4% ("a pinch, not the dish").
 */
export const brandColors = {
  red: '#E50914',
  charcoal: '#111820',
  orange: '#FF5A1F',
  green: '#167D32',
  white: '#FFFFFF',
} as const;

/** Brand copy in one place so it can be swapped. The guide PDF prints "Where Restaurants Meet Intelligence."; the owner asked for this line. */
export const brandCopy = {
  name: 'TheChilli.ai',
  wordmark: 'thechilli.ai',
  tagline: 'The secret ingredient is intelligence.',
  descriptor: 'AI Agents for Restaurants',
} as const;

export const chilli = {
  50: '#FFF1F1',
  100: '#FFE0E0',
  200: '#FFC2C2',
  300: '#FF9494',
  400: '#FF5A5A',
  500: '#F5222A',
  600: '#E50914',
  700: '#C20710',
  800: '#9B0309',
  900: '#6E0207',
} as const;

/**
 * Chilli Red for dark mode fills (primary button, active fills, brand marks): the guide's "lighter red with a charcoal label".
 * Chilli 400 (#FF5A5A) read as washed-out salmon next to the brand red; this tone keeps the brand hue and stays AA:
 * charcoal 900 label 5.05:1, as text on the dark surface 5.05:1.
 */
export const chilliDark = '#FF3B3B' as const;

/** Charcoal neutrals built from Dark Charcoal #111820. */
export const charcoal = {
  0: '#FFFFFF',
  50: '#F9FAFB',
  100: '#F3F4F6',
  200: '#E5E7EB',
  300: '#D1D5DB',
  400: '#9CA3AF',
  500: '#6B7280',
  600: '#4B5563',
  800: '#1F2937',
  900: '#111820',
} as const;

/** Semantic colour pairs (foreground / tint). Danger is deliberately not the brand red. */
export const semantic = {
  success: { fg: '#167D32', bg: '#EEF7EE' },
  warning: { fg: '#A16207', bg: '#FEFCE8' },
  danger: { fg: '#B91C1C', bg: '#FEF2F2' },
  info: { fg: '#1D4ED8', bg: '#EFF6FF' },
} as const;

export const lightColors = {
  bg: charcoal[50],
  surface: charcoal[0],
  'surface-2': charcoal[100],
  'surface-3': charcoal[200],
  border: charcoal[200],
  /** Input and control boundary: the guide draws inputs with a light grey edge; this is the lightest charcoal grey that keeps the WCAG 3:1 non-text minimum on the canvas (Charcoal 300 would be 1.4:1). */
  'border-strong': '#878D96',
  fg: charcoal[900],
  'fg-muted': charcoal[600],
  /** Charcoal 500 darkened a touch (#6B7280 -> #686F7C): 4.5:1 also on surface-2, so a disabled button label (4.4:1 before) and hints on a well pass AA. */
  'fg-subtle': '#686F7C',
  /** Chilli Red 600: primary buttons, active states. */
  primary: chilli[600],
  'primary-hover': chilli[700],
  /** Chilli 700: links and red text on light surfaces (6.3:1). */
  link: chilli[700],
  'on-primary': '#ffffff',
  'primary-soft': chilli[100],
  'primary-soft-fg': chilli[700],
  /** Chilli 50: selected row, header band, quiet highlight. */
  'primary-subtle': chilli[50],
  /** The logo red (same as primary). */
  brand: brandColors.red,
  /** Vibrant Orange: dots, highlights, icons >= 24px, borders. Never small text or a button label. */
  accent: brandColors.orange,
  ink: charcoal[900],
  'on-ink': '#ffffff',
  /** Accent text on an ink surface (toast Undo). */
  'ink-accent': chilli[300],
  success: semantic.success.fg,
  'success-soft': semantic.success.bg,
  'success-fg': '#136B2B',
  warning: semantic.warning.fg,
  'warning-soft': semantic.warning.bg,
  'warning-fg': '#854D0E',
  danger: semantic.danger.fg,
  'danger-soft': semantic.danger.bg,
  'danger-fg': '#991B1B',
  info: semantic.info.fg,
  'info-soft': semantic.info.bg,
  'info-fg': '#1E40AF',
  ring: chilli[600],
  /** FSSAI food marks: veg green square, non-veg red/brown triangle, egg amber. */
  veg: semantic.success.fg,
  'non-veg': semantic.danger.fg,
  egg: brandColors.orange,
  scrim: 'rgba(17, 24, 32, 0.45)',
} as const;

export type ColorToken = keyof typeof lightColors;

/**
 * Owner decision (2026-11-01): the product is LIGHT THEME ONLY. While this is true, the generated tokens.css carries no
 * `[data-theme='dark']` or `prefers-color-scheme: dark` override (only the always-dark kitchen `[data-kds]` subtree keeps the dark palette),
 * `resolveTheme` always answers 'light' and `setTheme` always applies 'light'. To bring dark mode back set this to false
 * (see docs/LIGHT_ONLY_STATUS.md for the full checklist). The dark palettes below and their tests stay as the documented palette.
 */
export const THEME_LIGHT_ONLY = true;

export type ThemeName = 'light' | 'dark';
export type ThemePreference = ThemeName | 'system';

/** The one place a theme is decided. Light-only: always 'light', whatever the stored preference or the OS says. */
export function resolveTheme(preference: ThemePreference | null | undefined = 'system', systemPrefersDark = false, lightOnly: boolean = THEME_LIGHT_ONLY): ThemeName {
  if (lightOnly) return 'light';
  if (preference === 'light' || preference === 'dark') return preference;
  return systemPrefersDark ? 'dark' : 'light';
}

/** Dark theme: Dark Charcoal surfaces; a lighter red for text and fills (charcoal label on it). */
export const darkColors: Record<ColorToken, string> = {
  bg: '#0B1015',
  surface: charcoal[900],
  'surface-2': charcoal[800],
  'surface-3': '#2A3442',
  border: '#2A3442',
  'border-strong': '#7C8590',
  fg: '#F5F6F8',
  'fg-muted': '#C2C8D0',
  'fg-subtle': '#9AA3AE',
  primary: chilliDark,
  'primary-hover': chilli[400],
  link: chilli[300],
  'on-primary': charcoal[900],
  'primary-soft': '#3A0F12',
  'primary-soft-fg': chilli[300],
  'primary-subtle': '#24090B',
  brand: chilliDark,
  accent: brandColors.orange,
  ink: '#F5F6F8',
  'on-ink': charcoal[900],
  'ink-accent': chilli[800],
  success: '#4ADE80',
  'success-soft': '#12301A',
  'success-fg': '#86EFAC',
  warning: '#FACC15',
  'warning-soft': '#33290A',
  'warning-fg': '#FDE047',
  danger: '#F87171',
  'danger-soft': '#3A1414',
  'danger-fg': '#FCA5A5',
  info: '#60A5FA',
  'info-soft': '#14223F',
  'info-fg': '#93C5FD',
  ring: chilliDark,
  veg: '#4ADE80',
  'non-veg': '#F87171',
  egg: brandColors.orange,
  scrim: 'rgba(0, 0, 0, 0.62)',
};

/** Kitchen mode: always dark regardless of theme. */
export const kdsColors = {
  'kds-bg': '#05080B',
  'kds-ticket': charcoal[900],
  'kds-new': darkColors.info,
  'kds-prep': darkColors.warning,
  'kds-ready': darkColors.success,
  /** Ticket older than its late threshold. */
  'kds-late': darkColors.danger,
} as const;

export const fontFamily = {
  /** Inter: product UI and body (400; 500/600 labels). Self-hosted from @chilli/tokens/fonts.css. Devanagari falls back to the system. */
  sans: "'Inter Variable', Inter, 'Noto Sans Devanagari', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  /** JetBrains Mono: amounts, KOT, codes (400/500, tabular). */
  mono: "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace",
  /** Poppins: headings 700 (Display, H1-H3), wordmark 800. */
  display: "Poppins, 'Inter Variable', Inter, system-ui, sans-serif",
  /** Montserrat SemiBold: the tagline. */
  tagline: "Montserrat, 'Inter Variable', Inter, system-ui, sans-serif",
} as const;

/** [font-size px, line-height px]. Generic steps, kept for existing consumers; the guide's named roles are in `textRoles`. */
export const typeScale = {
  xs: [12, 16],
  sm: [14, 20],
  base: [16, 24],
  lg: [18, 28],
  xl: [20, 28],
  '2xl': [24, 32],
  '3xl': [32, 40],
  '4xl': [48, 56],
} as const;

/** Guide type roles: [size, line-height, weight, letter-spacing em]. Display and H1-H3 are Poppins 700; body/label/caption Inter; amount JetBrains Mono. Caption is uppercase. */
export const textRoles = {
  display: [48, 56, 700, -0.02],
  h1: [32, 40, 700, -0.02],
  h2: [24, 32, 700, 0],
  h3: [18, 28, 700, 0],
  body: [15, 24, 400, 0],
  label: [14, 20, 500, 0],
  caption: [12, 16, 500, 0.04],
  amount: [16, 24, 500, 0],
} as const;

/** Inter 400 / 500 / 600 in the product; Poppins 700 headings and 800 wordmark; JetBrains Mono 400/500 numbers. */
export const fontWeight = { regular: 400, medium: 500, semibold: 600, bold: 700, extrabold: 800 } as const;

/** 4px grid. Guide steps s-1..s-16 = 4, 8, 12, 16, 24, 32, 48, 64 (20 and 40 kept for existing layouts). */
export const spacing = [4, 8, 12, 16, 20, 24, 32, 40, 48, 64] as const;

/** sm 6 buttons, inputs, chips; md 12 cards, table shells; lg 20 dialogs, login card; full pills, avatars. `xl` is an alias of lg; `mobile` 14 is tiles and buttons in the Chilli Staff app. */
export const radius = { sm: 6, md: 12, lg: 20, xl: 20, mobile: 14, full: 9999 } as const;

/** Elevation: e-0 is a 1px border only (cards, tables); e-1 raised (menus, popovers); e-2 overlay (dialogs, toasts). Prefer a border over a shadow. */
export const shadow = {
  pop: '0 1px 2px rgba(17, 24, 32, 0.06), 0 6px 16px -4px rgba(17, 24, 32, 0.12)',
  modal: '0 2px 6px rgba(17, 24, 32, 0.08), 0 18px 44px -8px rgba(17, 24, 32, 0.24)',
} as const;

/**
 * Shading. The design system is calm and flat ("prefer a 1px border over shadow"), so these resolve to the brand palette with almost
 * no gradient: the primary button and tiles are flat, the hero is Chilli Red -> a darker red. The variables stay so existing
 * consumers keep working. Every stop that text can sit on is listed so the contrast tests can check it.
 * CSS names carry a `--ch-` prefix so they never collide with an app's own variables.
 */
export const onHero = {
  /** Headings and body on the hero gradient. */
  fg: '#ffffff',
  /** Warm cream for secondary text on the hero (>= 4.5:1 on every text-bearing stop). */
  muted: chilli[50],
  /** Deep brown label on a white/cream button placed on the hero (9:1 on white). */
  ink: chilli[900],
  /** Outline of a secondary button on the hero, and its hover fill. */
  line: 'rgb(255 255 255 / 0.7)',
  tint: 'rgb(255 255 255 / 0.12)',
  /** Bottom scrim under text laid over a photo or clip (deep brown, so white/cream text keeps AA on any picture). */
  scrim: 'rgb(17 24 32 / 0.78)',
  scrimMid: 'rgb(17 24 32 / 0.62)',
} as const;

/** Theme-independent shading helpers: top highlight on filled buttons, pressed inset, lifted hover on the hero. */
export const shadingFx = {
  insetHi: 'inset 0 1px 0 rgb(255 255 255 / 0.14)',
  insetPress: 'inset 0 2px 6px rgb(0 0 0 / 0.22)',
  lift: '0 6px 18px -6px rgb(0 0 0 / 0.45)',
} as const;

export interface Shading {
  /** Hero / brand panel, top-left to bottom-right. Text may sit on any of these. */
  heroStops: readonly string[];
  /** Plain colour painted under the hero gradient (contrast tools cannot measure a gradient): the stop that keeps white text >= 4.5:1. */
  heroFallback: string;
  /** Soft peach light in the top-right corner of the hero (decorative: keep text out of its centre). */
  heroGlow: string;
  /** The same light at about half strength: a middle stop so the glow melts in without a visible edge. */
  heroGlowSoft: string;
  /** Primary button fill, top to bottom (label sits on all three). */
  primaryStops: readonly string[];
  primaryHoverStops: readonly string[];
  /** KPI tile / card face, top-left to bottom-right (body text sits on all). */
  tileStops: readonly string[];
  /** Top-of-page wash: this colour fades into the canvas (`bg`). */
  washTop: string;
  /** Faint glow at the top of the app canvas. */
  canvasGlow: string;
  /** Sign-in page backdrop: two soft colour washes (top-left peach, bottom-right saffron) over `surface-3`. */
  pageGlowA: string;
  pageGlowB: string;
  /** Warm-tinted elevation for tiles and the primary button. */
  shadowTile: string;
  shadowWarm: string;
}

export const lightShading: Shading = {
  heroStops: [chilli[700], '#AE060F', chilli[800], chilli[900]],
  /** Chilli 700 #C20710, the first and lightest stop: white on it is 6.3:1. */
  heroFallback: chilli[700],
  heroGlow: 'rgb(255 90 31 / 0.35)',
  heroGlowSoft: 'rgb(255 90 31 / 0.12)',
  primaryStops: [chilli[600], chilli[600], chilli[600]],
  primaryHoverStops: [chilli[700], chilli[700], chilli[700]],
  tileStops: ['#ffffff', '#ffffff', '#ffffff'],
  washTop: charcoal[0],
  canvasGlow: 'rgb(229 9 20 / 0)',
  pageGlowA: 'rgb(255 228 229 / 0)',
  pageGlowB: 'rgb(229 9 20 / 0)',
  shadowTile: 'none',
  shadowWarm: '0 1px 2px rgb(17 24 32 / 0.10)',
};

export const darkShading: Shading = {
  heroStops: [chilli[800], chilli[900], '#3A0306', charcoal[900]],
  /** Chilli 800 #9B0309, the first and lightest stop: white on it is 9.6:1 (the dark-theme hover tone #FF5A5A would fail with white text). */
  heroFallback: chilli[800],
  heroGlow: 'rgb(255 90 31 / 0.25)',
  heroGlowSoft: 'rgb(229 9 20 / 0.12)',
  primaryStops: [chilliDark, chilliDark, chilliDark],
  primaryHoverStops: [chilli[400], chilli[400], chilli[400]],
  tileStops: [charcoal[900], charcoal[900], charcoal[900]],
  washTop: '#24090B',
  canvasGlow: 'rgb(229 9 20 / 0)',
  pageGlowA: 'rgb(229 9 20 / 0)',
  pageGlowB: 'rgb(255 77 85 / 0)',
  shadowTile: 'none',
  shadowWarm: '0 1px 2px rgb(0 0 0 / 0.4)',
};

/**
 * Sign-in picture panel (owner direction 2026-10-31): real photos; when there are none (or while the first one loads) an airy
 * pastel peach panel in light theme, the deep warm gradient in dark theme. Chips are small decorative sample cards over the photo.
 */
export interface Scene {
  /** Panel background behind / instead of the photos. */
  bg: string;
  /** Solid stops of that background where the headline sits (tests check the headline colours against them). */
  bgTextStops: readonly string[];
  /** Headline and tagline on the bare panel (over photos they are white/cream on the scrim). */
  ink: string;
  inkMuted: string;
  chipBg: string;
  chipFg: string;
  /** Saffron shape on the sign-in card (owner reference 8.png): smooth, no grain; white text sits on every stop. */
  shape: string;
  shapeTextStops: readonly string[];
  /** Plain colour painted under the shape gradient (contrast tools cannot measure a gradient): the stop that keeps white text >= 4.5:1. */
  shapeFallback: string;
}

export const lightScene: Scene = {
  bg: `linear-gradient(168deg, ${chilli[50]} 0%, ${chilli[100]} 48%, ${chilli[200]} 100%)`,
  bgTextStops: [chilli[50], chilli[100], chilli[200]],
  ink: charcoal[900],
  inkMuted: charcoal[600],
  chipBg: 'rgb(255 255 255 / 0.94)',
  chipFg: charcoal[900],
  /** Chilli 600 -> 700; white text keeps >= 4.5:1 on every stop (4.8 / 6.3). */
  shape: `linear-gradient(160deg, ${chilli[600]} 0%, ${chilli[700]} 100%)`,
  shapeTextStops: [chilli[600], chilli[700]],
  /** Chilli 600 #E50914: white on it is 4.79:1. */
  shapeFallback: chilli[600],
};

export const darkScene: Scene = {
  bg: 'var(--ch-grad-hero)',
  bgTextStops: [chilli[800], chilli[900], charcoal[900]],
  ink: '#ffffff',
  inkMuted: chilli[50],
  chipBg: 'rgb(17 24 32 / 0.92)',
  chipFg: '#F5F6F8',
  shape: `linear-gradient(160deg, ${chilli[700]} 0%, ${chilli[800]} 55%, ${chilli[900]} 100%)`,
  shapeTextStops: [chilli[700], chilli[800], chilli[900]],
  /** Chilli 700 #C20710, the first and lightest stop: white on it is 6.3:1 (the dark-theme primary #FF3B3B would fail with a white label). */
  shapeFallback: chilli[700],
};

/** Fine film grain: 128px fractal-noise tile (inline SVG, ~0.3 KB, no request). Use at low opacity. */
export const grain =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='128' height='128'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='128' height='128' filter='url(%23g)'/%3E%3C/svg%3E\")";

export const motion = {
  duration: { press: 100, fade: 160, enter: 220 },
  easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
} as const;

export type Density = 'touch' | 'comfortable' | 'compact' | 'far';

export const densities: Record<
  Density,
  { control: number; pay: number; body: number; lineHeight: number; target: number; gap: number; cellY: number }
> = {
  touch: { control: 48, pay: 56, body: 15, lineHeight: 24, target: 44, gap: 8, cellY: 14 },
  comfortable: { control: 40, pay: 56, body: 15, lineHeight: 24, target: 40, gap: 8, cellY: 14 },
  compact: { control: 36, pay: 44, body: 14, lineHeight: 20, target: 32, gap: 4, cellY: 6 },
  /** Kitchen mode and token boards, readable at 2 m (strategy 4.4). */
  far: { control: 56, pay: 64, body: 22, lineHeight: 30, target: 64, gap: 12, cellY: 16 },
};

export const breakpoints = { tablet: 768, desktop: 1024 } as const;
