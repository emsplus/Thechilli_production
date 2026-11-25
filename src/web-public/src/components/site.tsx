import Link from "next/link";
import { T } from "@/i18n/locale";
import { Wordmark } from "@/components/brand";

/**
 * Sign-up only app (owner 2026-11-02): the marketing website is a separate static site on the same host, and the reverse
 * proxy sends only /signup*, /terms*, /privacy*, /_next/* and /brand/* here. So the header is the logo (a plain link to
 * "/", the marketing home on the shared host; "/" redirects to /signup when this app is served alone) and one
 * "Get started" button; the footer has the legal links and the copyright only.
 */
export function Header() {
  return (
    <header className="topbar">
      <a className="skip" href="#main"><T k="skip" /></a>
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- "/" belongs to the marketing site on the shared host */}
      <a href="/" className="brand"><Wordmark height={26} /></a>
      <div className="spacer" />
      <Link href="/signup" className="ch-btn ch-btn--primary ch-btn--sm"><T k="nav.signup" /></Link>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="footer">
      <nav className="footer-legal" aria-label="Legal">
        <Link href="/terms"><T k="footer.terms" /></Link>
        <Link href="/privacy"><T k="footer.privacy" /></Link>
      </nav>
      <p className="small muted copy">© {new Date().getFullYear()} <T k="footer.copy" /></p>
    </footer>
  );
}
