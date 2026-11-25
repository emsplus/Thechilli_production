"use client";

import { Toaster as Sonner, toast } from "sonner";
import { useTheme } from "@/components/theme/theme";

/** Mounted once in the root layout. Use `toast.success("Saved")`, `toast.error(msg)`, `toast(msg)`. */
export function Toaster() {
  const { theme } = useTheme();
  return (
    <Sonner
      theme={theme}
      position="top-center"
      offset={{ top: 12 }}
      mobileOffset={{ top: 12 }}
      closeButton
      toastOptions={{
        duration: 3500,
        classNames: { toast: "!rounded-2xl !border-border !bg-surface !text-fg !shadow-modal !font-sans", description: "!text-fg-muted" },
      }}
    />
  );
}

export { toast };
