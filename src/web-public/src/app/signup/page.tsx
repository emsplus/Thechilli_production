import type { Metadata } from "next";
import { SignupWizard } from "@/components/signup";
import { T } from "@/i18n/locale";
import { APP_SIGNIN_URL } from "@/lib/site";

export const metadata: Metadata = { title: "Start sign-up", description: "Apply for TheChilli.ai in about 3 minutes: what you run, business, outlets, owner contact. We review every application." };

export default function Signup() {
  return (
    <>
      <div className="page-head">
        <h1><T k="signup.title" /></h1>
        <p className="lead"><T k="signup.lead" /></p>
        <p className="signin-line"><span className="muted"><T k="signup.have" /></span><a href={APP_SIGNIN_URL}><T k="signup.signin" /></a></p>
      </div>
      <div className="signup-layout">
        <SignupWizard />
        <aside className="ch-card signup-aside" aria-labelledby="after-h">
          <h2 id="after-h" className="h3" style={{ fontSize: "var(--text-lg)" }}><T k="signup.after" /></h2>
          <ol>
            <li><T k="signup.next.1" /></li>
            <li><T k="signup.next.2" /></li>
            <li><T k="signup.next.3" /></li>
          </ol>
        </aside>
      </div>
    </>
  );
}
