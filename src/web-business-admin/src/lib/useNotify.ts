"use client";

import { useMemo } from "react";
import { useToast } from "@chilli/ui";

/** Toasts from the design system: errors stay until dismissed and are announced assertively. */
export function useNotify() {
  const t = useToast();
  return useMemo(() => ({ success: (m: string) => t.show(m, "success"), error: (m: string) => t.show(m, "danger"), info: (m: string) => t.show(m, "info") }), [t]);
}
