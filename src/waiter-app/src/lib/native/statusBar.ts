import { Capacitor } from "@capacitor/core";
import { StatusBar, Style } from "@capacitor/status-bar";
import { MOBILE_THEME, darkAllowed } from "@/lib/mobileTheme";
import { PageBackground } from "./pageBackground";

/**
 * Status bar style override per platform. Android keeps the config value (DARK on the terracotta bar), so it returns null.
 * iOS draws the bar over the light app background, which needs dark text (Style.Light = "for light backgrounds").
 */
export const statusBarStyleFor = (platform: string): Style | null => (platform === "ios" ? Style.Light : null);

export function applyStatusBarStyle(platform: string = Capacitor.getPlatform()): void {
  const style = statusBarStyleFor(platform);
  if (style) void StatusBar.setStyle({ style }).catch(() => {});
}

/** Never throws: a missing plugin must not break startup. */
const nativePlatform = (): "android" | "ios" | null => {
  try {
    if (typeof window === "undefined" || !Capacitor.isNativePlatform()) return null;
    const p = Capacitor.getPlatform();
    return p === "android" || p === "ios" ? p : null;
  } catch { return null; }
};
/** Light only: always false while APPLIED_THEME is "light", whatever the phone is set to. */
const prefersDark = (): boolean => darkAllowed() && typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;

/** Splash: orange bar with light icons, matching the splash background (iOS has no bar colour, only the icon style). */
export function statusBarForSplash(): void {
  const p = nativePlatform();
  if (!p) return;
  if (p === "android") {
    void StatusBar.setBackgroundColor({ color: MOBILE_THEME.splash }).catch(() => {});
    void PageBackground.set({ color: MOBILE_THEME.splash }).catch(() => {});
  }
  void StatusBar.setStyle({ style: Style.Dark }).catch(() => {}); // Style.Dark = light icons for a dark/saturated bar
}

/** Everywhere else: bar follows the page background (light or near-black) with matching icon colour. */
export function statusBarForApp(): void {
  const p = nativePlatform();
  if (!p) return;
  const dark = prefersDark();
  if (p === "android") {
    const color = dark ? MOBILE_THEME.pageDark : MOBILE_THEME.pageLight;
    void StatusBar.setBackgroundColor({ color }).catch(() => {});
    void PageBackground.set({ color }).catch(() => {});
  }
  if (p === "ios" && !dark) { applyStatusBarStyle("ios"); return; }
  void StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light }).catch(() => {});
}
