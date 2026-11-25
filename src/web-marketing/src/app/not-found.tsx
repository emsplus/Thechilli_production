import Link from "next/link";
import { Wordmark } from "@/components/brand";

export const metadata = { title: "Page not found" };

/** Branded 404: logo, plain words, one way back (UI review MK-7). */
export default function NotFound() {
  return (
    <main className="nf">
      <Wordmark height={32} />
      <p className="nf__code">404</p>
      <h1>This page does not exist</h1>
      <p className="muted">The link may be old or mistyped.</p>
      <Link href="/" className="ch-btn ch-btn--primary ch-btn--md">Go to My day</Link>
    </main>
  );
}
