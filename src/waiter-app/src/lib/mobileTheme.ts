/**
 * Mobile theme constants that must be known in JS (status bar, manifest, PWA theme colour, native splash). The CSS layer in
 * app/globals.css holds the same values; mobileTheme.test.ts fails if they drift or if a text pair drops below WCAG AA.
 * Brand: owner guide 2026-10-31 (@chilli/tokens): Chilli Red #E50914 and its 700/800 shades, Dark Charcoal neutrals.
 */
/**
 * LIGHT ONLY (owner decision 2026-11-01): no dark mode, no theme switch, a phone set to dark still shows the light theme.
 * The dark token definitions stay in the code but are inert: they only apply when <html> has no data-theme="light" (tokens.css and
 * globals.css both use `:root:not([data-theme="light"])` inside the dark media query).
 * TO TURN DARK BACK ON: set APPLIED_THEME to "auto" (follow the phone) and see docs/LIGHT_ONLY_STATUS.md for the native side.
 */
export const APPLIED_THEME = "light" as "light" | "auto";
/** Value of <html data-theme>: "light" pins the light tokens, undefined lets prefers-color-scheme pick. */
export const htmlThemeAttr: "light" | undefined = APPLIED_THEME === "light" ? "light" : undefined;
/** True only when the app may follow the phone's dark appearance (never while light only). */
export const darkAllowed = (): boolean => APPLIED_THEME === "auto";

export const MOBILE_THEME = {
  splash: "#e50914", // Chilli Red 600: splash, native launch screen and Android status bar on the splash
  splashB: "#c20710", // Chilli 700
  splashC: "#9b0309", // Chilli 800 at the bottom of the splash, under "Chilli Staff"
  splashInk: "#ffffff",
  primary: "#e50914", // @chilli/tokens --c-primary (light): every filled button
  onPrimary: "#ffffff",
  link: "#c20710", // @chilli/tokens --c-link (light): red text (links, "Forgot Password?", outline buttons)
  buttonA: "#e50914", // filled button stops (middle, top, bottom): white text >= 4.5:1 on each
  buttonB: "#e50914",
  buttonC: "#c20710",
  pageLight: "#f9fafb", // @chilli/tokens --c-bg (Charcoal 50)
  pageDark: "#0b1015", // @chilli/tokens --c-bg (dark). Kept for the day dark returns; nothing applies it while APPLIED_THEME is "light".
} as const;
