"use client";

import { useEffect, type ReactNode } from "react";
import { MotionConfig } from "motion/react";
import { ToastProvider } from "@chilli/ui";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { Toaster } from "@/components/ui/toaster";
import { useEffectsLevel } from "@/components/theme/effects";
import { LocaleProvider } from "@/lib/i18n";
import { TaxConfigBoot } from "@/components/TaxConfigBoot";
import { installFocusReturn } from "@/lib/focusReturn";
import { StepUpHost } from "@/components/devices/StepUpHost";

/**
 * Global client providers: motion (honours prefers-reduced-motion, and the "Reduce effects" setting), confirm
 * dialogs, toasts.
 */
export function Providers({ children }: { children: ReactNode }) {
  const { level } = useEffectsLevel();
  useEffect(() => installFocusReturn(), []); // closing a dialog gives focus back to what opened it (QA D18)
  return (
    <MotionConfig reducedMotion={level === "reduced" ? "always" : "user"}>
      <LocaleProvider>
        <ConfirmProvider>
          <TaxConfigBoot />
          <ToastProvider>{children}</ToastProvider>
          <Toaster />
          <StepUpHost />
        </ConfirmProvider>
      </LocaleProvider>
    </MotionConfig>
  );
}
