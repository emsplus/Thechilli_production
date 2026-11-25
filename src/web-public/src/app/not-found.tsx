import { T } from "@/i18n/locale";
import { Wordmark } from "@/components/brand";

/** Branded 404 (UI review PW-9): logo, plain words, one way home. */
export default function NotFound() {
  return (
    <div className="page-head nf">
      <Wordmark height={32} />
      <p className="nf__code">404</p>
      <h1><T k="nf.title" /></h1>
      <p className="lead"><T k="nf.d" /></p>
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- "/" is the marketing home on the shared host (redirects to /signup when served alone) */}
      <p><a href="/" className="ch-btn ch-btn--primary"><T k="nf.home" /></a></p>
    </div>
  );
}
