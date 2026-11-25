import type { Metadata } from "next";
import { T } from "@/i18n/locale";

export const metadata: Metadata = { title: "Terms of use (draft)", robots: { index: false } };

export default function Page() {
  return (
    <>
      <div className="page-head"><h1><T k="terms.title" /></h1></div>
      <div className="legal">
        <p className="notice" role="note"><strong><T k="legal.review" /></strong></p>
        <p className="small muted"><T k="legal.updated" /> · <T k="legal.lang" /></p>
        <h2><T k="terms.h1" /></h2>
        <p><T k="terms.p1" /></p>
        <h2><T k="terms.h2" /></h2>
        <p><T k="terms.p2" /></p>
        <h2><T k="terms.h3" /></h2>
        <p><T k="terms.p3" /></p>
        <h2><T k="terms.h4" /></h2>
        <p><T k="terms.p4" /></p>
        <h2><T k="terms.h5" /></h2>
        <p><T k="terms.p5" /></p>
        
      </div>
    </>
  );
}
