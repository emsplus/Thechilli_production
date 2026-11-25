"use client";

import type { ReactNode } from "react";
import { AuthSplit, type AuthMediaItem } from "@chilli/ui/auth";
import Link from "next/link";
import "@chilli/ui/auth.css";
import { PillLogo, Wordmark } from "@/components/BrandMark";
import manifest from "../../../public/auth-media/manifest.json";

/** Sign-in carousel: edit public/auth-media/manifest.json (see docs/AUTH_MEDIA_SPEC.md). Empty = plain Chilli Red shape. */
export const AUTH_MEDIA = manifest as AuthMediaItem[];

/** Logo above the title: the thechilli.ai wordmark (owner file; light theme only). */
export const AuthLogo = () => <Wordmark height={36} />;

/**
 * /login and /register: the shared split card from the design system (media carousel left, logo + title + pill
 * fields right; the media panel is a short banner on tablets and hidden on phones).
 */
type Side = "login" | "register" | "help";

/** Copy on the Chilli Red shape (true statements only). Login invites new restaurants to register; register points back to log in. */
const SIDE: Record<Side, { headline: string; tagline: string; action?: ReactNode }> = {
  login: { headline: "New to Chilli?", tagline: "Register your restaurant and start taking orders today.", action: <Link className="ch-auth__action" href="/register">Register</Link> },
  register: { headline: "Already registered?", tagline: "Log in to your restaurant.", action: <Link className="ch-auth__action" href="/login">Log in</Link> },
  help: { headline: "Run your restaurant, simply.", tagline: "Orders, kitchen, bills and reports in one place." },
};

/** /login and /register: the shared design-system card (form left, Chilli Red shape right; the shape is a banner on phones). */
export function AuthPage({ title, subtitle, footer, side = "login", children }: { title: ReactNode; subtitle?: ReactNode; footer?: ReactNode; side?: Side; children: ReactNode }) {
  return (
    <AuthSplit logo={<AuthLogo />} shapeLogo={<PillLogo />} title={title} subtitle={subtitle} footer={footer} media={AUTH_MEDIA} {...SIDE[side]}>
      {children}
    </AuthSplit>
  );
}

/** The same card for pages that render their own heading (forgot / reset password). */
export function AuthShell({ children }: { children: ReactNode; tall?: boolean }) {
  return (
    <AuthSplit logo={<AuthLogo />} shapeLogo={<PillLogo />} media={AUTH_MEDIA} {...SIDE.help}>
      {children}
    </AuthSplit>
  );
}
