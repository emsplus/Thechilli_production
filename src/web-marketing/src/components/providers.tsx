"use client";
import type { ReactNode } from "react";
import { ToastProvider } from "@chilli/ui";
import { AuthProvider } from "./auth";

// @chilli/ui ships without "use client", so it must be imported from a client module.
export function Providers({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <AuthProvider>{children}</AuthProvider>
    </ToastProvider>
  );
}
