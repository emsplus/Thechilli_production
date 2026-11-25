"use client";
import type { ReactNode } from "react";
import { ToastProvider } from "@chilli/ui";
import { SessionProvider } from "@/lib/session";
import { StepUpHost } from "./StepUpDialog";

export function Providers({ children }: { children: ReactNode }) {
  return <ToastProvider><SessionProvider>{children}<StepUpHost /></SessionProvider></ToastProvider>;
}
