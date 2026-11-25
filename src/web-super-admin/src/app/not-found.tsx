import Link from "next/link";
import { Wordmark } from "@/components/Brand";

export const metadata = { title: "Page not found" };

/** Branded 404: logo, plain words, one way back. */
export default function NotFound() {
  return (
    <main className="hq-404">
      <Wordmark height={32} />
      <p className="hq-404__code">404</p>
      <h1 className="hq-h1">This page does not exist</h1>
      <p className="hq-sub">The link may be old or mistyped.</p>
      <Link href="/" className="ch-btn ch-btn--primary ch-btn--md">Go to Overview</Link>
    </main>
  );
}
