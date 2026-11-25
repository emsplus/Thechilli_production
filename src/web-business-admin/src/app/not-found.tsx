"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { Compass } from "lucide-react";
import { BrandMark } from "@/components/BrandMark";
import { auth } from "@/lib/api";

const noop = () => () => {};

/**
 * Friendly 404 (UI_REVIEW BA-22). Signed in: inside the app shell (AppShell keeps it there), with a way back home.
 * Signed out: a page of its own with a sign-in link; never an automatic redirect to /login.
 */
export default function NotFound() {
  const signedIn = useSyncExternalStore(noop, () => !!auth.token, () => null);
  const body = (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center" data-testid="not-found">
      <div className="grid size-16 place-items-center rounded-3xl bg-primary-soft text-primary-soft-fg [&_svg]:size-7"><Compass aria-hidden /></div>
      <h1 className="font-display text-2xl font-extrabold tracking-tight text-fg">Page not found</h1>
      <p className="max-w-sm text-fg-muted">This address does not match any page. It may have moved, or the link has a typo.</p>
      <div className="mt-2 flex flex-wrap justify-center gap-3">
        {signedIn === false
          ? <Link href="/login" className="ch-btn ch-btn--primary ch-btn--lg">Sign in</Link>
          : <Link href="/" className="ch-btn ch-btn--primary ch-btn--lg">Go to home</Link>}
      </div>
    </div>
  );
  if (signedIn) return body;
  return (
    <main id="main-content" className="grid min-h-dvh place-items-center bg-bg px-4">
      <div className="w-full max-w-md">
        <div className="mb-2 flex justify-center"><BrandMark className="size-10" /></div>
        {body}
      </div>
    </main>
  );
}
