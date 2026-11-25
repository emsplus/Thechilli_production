/* eslint-disable @next/next/no-img-element -- static brand PNG in /public, precached by the service worker */
import { cn } from "@/lib/cn";

/**
 * The brand logo badge: the owner's app icon (white rounded tile with the circuit chilli; style guide v1.0 "App icon · Light").
 * Size it with a size-* class. `priority` is accepted for callers that used the old image; it has no effect now.
 */
export function BrandMark({ className }: { className?: string; priority?: boolean }) {
  return (
    <img src="/icon-192.png" alt="TheChilli.ai" width={192} height={192} draggable={false}
      className={cn("size-9 shrink-0 rounded-[22%] bg-white object-contain", className)} />
  );
}

/** The thechilli.ai wordmark (Poppins ExtraBold, owner file): charcoal "the"/"ai" and red "chilli" (light theme only). */
export function Wordmark({ height = 32, className }: { height?: number; className?: string }) {
  return (
    <picture className={className}>
      <img src="/brand/logo-wordmark.png" alt="thechilli.ai" height={height} width={Math.round(height * 4.79)} style={{ display: "block" }} />
    </picture>
  );
}

/** The wordmark inside the white pill on the sign-in shape (always the light version: the pill is white in both themes). */
export function PillLogo() {
  return <img src="/brand/logo-wordmark.png" alt="" width={154} height={32} />;
}
