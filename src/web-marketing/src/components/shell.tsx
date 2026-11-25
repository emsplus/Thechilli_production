"use client";
import Link from "next/link";
import { Wordmark } from "@/components/brand";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { SkeletonGroup, Skeleton } from "@chilli/ui";
import { canAccessPath, MORE_LINKS, ROLE_LABEL, visibleAreas, areaForPath, splitBottomNav } from "@/lib/roles";
import { MOCK_MODE } from "@/lib/api";
import { loginUrl } from "@/lib/return-to";
import { NoAccess } from "./ui";
import { useAuth } from "./auth";

export function Shell({ children }: { children: ReactNode }) {
  const { user, status, logout } = useAuth();
  const router = useRouter();
  const path = usePathname();
  const [moreAt, setMoreAt] = useState<string | null>(null); // More is open only on the page it was opened from
  const moreOpen = moreAt === path;

  useEffect(() => { if (status === "anon") router.replace(loginUrl(`${window.location.pathname}${window.location.search}`)); }, [status, router]);

  if (status !== "authed" || !user) {
    return <div className="main"><SkeletonGroup><Skeleton height={40} /></SkeletonGroup></div>;
  }
  const areas = visibleAreas(user.role);
  const current = areaForPath(path);
  const extras = MORE_LINKS.filter((l) => canAccessPath(user.role, l.href));
  const onExtra = extras.some((l) => path === l.href || path.startsWith(l.href + "/"));
  const { primary, more: moreAreas } = extras.length ? { primary: areas.slice(0, 4), more: areas.slice(4) } : splitBottomNav(areas); // phone: 4 areas + More
  const more = [...moreAreas, ...extras];
  const initials = user.name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();

  return (
    <div className="shell">
      <a className="skip" href="#main">Skip to content</a>
      <header className="topbar">
        <Link href="/" className="brand"><Wordmark height={22} /><span className="brand-portal">Partner</span></Link>
        <nav className="topnav" aria-label="Main">
          {areas.map((a) => <Link key={a.key} href={a.href} aria-current={current?.key === a.key && !onExtra ? "page" : undefined}>{a.label}</Link>)}
          <details className="menu nav-more" key={path}>
            <summary aria-current={onExtra ? "page" : undefined}>More<span aria-hidden="true" className="caret">▾</span></summary>
            <div className="menu-panel menu-panel--start">
              {extras.map((l) => <Link key={l.key} href={l.href} aria-current={path === l.href ? "page" : undefined}>{l.label}</Link>)}
            </div>
          </details>
        </nav>
        <span className="spacer" />
        {MOCK_MODE && <span className="small muted demo-flag" title="Running against the mocked API">Demo data</span>}
        <details className="menu">
          <summary><span className="avatar" aria-hidden="true">{initials}</span><span className="ch-sr-only">Account menu</span></summary>
          <div className="menu-panel">
            <div className="menu-who"><strong>{user.name}</strong><div className="small muted">{ROLE_LABEL[user.role]}</div></div>
            <Link href="/account">Account</Link>
            <button type="button" onClick={async () => { await logout(); router.replace("/login"); }}>Sign out</button>
          </div>
        </details>
      </header>
      <main id="main" className="main">
        {canAccessPath(user.role, path) ? children : <NoAccess role={user.role} what="This area" />}
      </main>
      <nav className="bottomnav" aria-label="Main">
        {primary.map((a) => <Link key={a.key} href={a.href} aria-current={current?.key === a.key && !onExtra ? "page" : undefined}>{a.label}</Link>)}
        {more.length > 0 && (
          <>
            <button type="button" className="more-btn" aria-expanded={moreOpen} aria-controls="more-panel" aria-current={onExtra || (current && moreAreas.some((a) => a.key === current.key)) ? "page" : undefined} onClick={() => setMoreAt(moreOpen ? null : path)}>More</button>
            {moreOpen && <div id="more-panel" className="more-panel">{more.map((a) => <Link key={a.key} href={a.href} aria-current={path === a.href || (!onExtra && current?.key === a.key) ? "page" : undefined}>{a.label}</Link>)}</div>}
          </>
        )}
      </nav>
    </div>
  );
}
