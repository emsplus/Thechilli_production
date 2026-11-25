"use client";

import { resolveTheme } from "@chilli/tokens";
import { useCallback } from "react";

export type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";

/**
 * Light theme only (owner decision 2026-11-01): the resolved theme is always "light" (see THEME_LIGHT_ONLY in @chilli/tokens).
 * There is no preference to store and no toggle; the setters are kept as no-ops so a future dark mode only has to change this file.
 */
export function useTheme() {
  const theme: Theme = resolveTheme("system", false);
  const setTheme = useCallback((t: ThemePreference) => { void t; /* light only: nothing to switch */ }, []);
  const toggle = useCallback(() => { /* light only */ }, []);
  return { theme, preference: "light" as ThemePreference, setTheme, toggle };
}
