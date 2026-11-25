"use client";
import Link from "next/link";
import { LeafArt, Wave } from "@/components/Scenery";
import { useT } from "@/lib/i18n";
import { SIGNUP_URL } from "@/lib/signupUrl";

/**
 * Sign Up keeps the reference look but is honest: staff accounts are created by the owner (no self-signup API), and owner
 * registration is the web flow. So: an explanation and a button that opens the web signup in the system browser.
 */
export default function SignUp() {
  const t = useT();
  return (
    <div className="entry" style={{ ["--art-h" as string]: "24dvh" }}>
      <header className="art"><LeafArt compact /><Wave /></header>
      <main id="main" className="body grow">
        <h1>{t("signup.title")}</h1>
        <p className="sub">{t("signup.sub")}</p>
        <span className="accent" aria-hidden="true" />
        <div className="card"><p>{t("signup.staff")}</p></div>
        <p className="hint">{t("signup.owner")}</p>
        <div className="spacer" />
        <div className="actions col">
          <a className="btn primary grad block pillbtn" href={SIGNUP_URL} target="_blank" rel="noopener noreferrer">{t("signup.cta")}</a>
          <Link className="btn outline block pillbtn" href="/login">{t("login.submit")}</Link>
        </div>
      </main>
    </div>
  );
}
