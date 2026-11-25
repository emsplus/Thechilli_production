"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Button, EmptyState, ErrorState } from "@chilli/ui";
import { visibleNav } from "@/lib/nav";
import { ROLE_LABEL } from "@/lib/permissions";
import { useRouteGuard, useSession } from "@/lib/session";
import { LoadingRows } from "./ui";
import { Wordmark } from "@/components/Brand";

export function Shell({ children }: { children: ReactNode }) {
  const { state, perms, signOut, reload } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const allowed = useRouteGuard();
  const [openFor, setOpenFor] = useState<string | null>(null);
  const open = openFor === pathname;

  useEffect(() => { if (state.status === "anon") router.replace("/login"); }, [state.status, router]);

  if (state.status === "loading" || state.status === "anon") return <div className="hq-boot"><LoadingRows rows={3} /></div>;
  if (state.status === "error") return <div className="hq-boot"><ErrorState title="Cannot load your session" description={state.error.message} onAction={reload} /></div>;

  const nav = visibleNav(perms);
  const me = state.me;
  const activeArea = nav.find((a) => a.items.some((i) => (i.href === "/" ? pathname === "/" : pathname === i.href || pathname.startsWith(i.href + "/"))));

  return (
    <div className="hq-shell">
      <a className="hq-skip" href="#main">Skip to content</a>
      <header className="hq-top">
        <button className="hq-menu ch-btn ch-btn--ghost" aria-expanded={open} aria-controls="hq-nav" onClick={() => setOpenFor(open ? null : pathname)}>Menu</button>
        <Link href="/" className="hq-brand" aria-label="TheChilli.ai Super Admin, home"><Wordmark height={24} /><span className="hq-brand__portal">Super Admin</span></Link>
        <div className="hq-user">
          <Link href="/account" className="hq-userlink" aria-label={`${me.name} ${ROLE_LABEL[me.role]}, account`}>
            <span>{me.name}</span> <small>{ROLE_LABEL[me.role]}</small>
          </Link>
          <Button size="sm" onClick={() => void signOut()}>Sign out</Button>
        </div>
      </header>
      <nav id="hq-nav" className={`hq-nav${open ? " is-open" : ""}`} aria-label="Main">
        <ul>
          {nav.map((a) => (
            <li key={a.id}>
              {a.items.length === 1 ? (
                <Link href={a.href} className="hq-area" aria-current={activeArea?.id === a.id ? "page" : undefined}>{a.label}</Link>
              ) : (
                <>
                  <span className="hq-area hq-area--label" id={`area-${a.id}`}>{a.label}</span>
                  <ul aria-labelledby={`area-${a.id}`}>
                    {a.items.map((i) => (
                      <li key={i.href}>
                        <Link href={i.href} className="hq-item" aria-current={pathname === i.href || pathname.startsWith(i.href + "/") ? "page" : undefined}>{i.label}</Link>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </li>
          ))}
        </ul>
      </nav>
      <main id="main" tabIndex={-1} className="hq-main">
        {allowed ? children : <EmptyState title="Not available for your role" description="Ask a super admin if you need access to this area." actionLabel="Go to overview" onAction={() => router.push("/")} />}
      </main>
    </div>
  );
}
