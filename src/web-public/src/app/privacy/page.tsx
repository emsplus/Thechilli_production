import type { Metadata } from "next";
import { T } from "@/i18n/locale";

export const metadata: Metadata = { title: "Privacy notice (draft)", robots: { index: false } };

export default function Page() {
  return (
    <>
      <div className="page-head"><h1><T k="privacy.title" /></h1></div>
      <div className="legal">
        <p className="notice" role="note"><strong><T k="legal.review" /></strong></p>
        <p className="small muted"><T k="legal.updated" /> · <T k="legal.lang" /></p>
        <h2><T k="privacy.h1" /></h2>
        <p><T k="privacy.p1" /></p>
        <h2><T k="privacy.h2" /></h2>
        <p><T k="privacy.p2" /></p>
        <h2><T k="privacy.h3" /></h2>
        <p><T k="privacy.p3" /></p>
        <h2><T k="privacy.h4" /></h2>
        <p><T k="privacy.p4" /></p>
        <h2><T k="privacy.h5" /></h2>
        <p><T k="privacy.p5" /></p>
        <h2><T k="privacy.h6" /></h2>
        <p><T k="privacy.p6" /></p>
        
      </div>
    </>
  );
}
