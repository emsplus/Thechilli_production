"use client";
import { useRouter } from "next/navigation";
import { LeafArt, Wave } from "@/components/Scenery";
import { markWelcomeSeen } from "@/lib/firstLaunch";
import { useT } from "@/lib/i18n";

/** First-launch screen: leaf art over a wavy white curve, "Welcome", sub line, underline accent, SIGN IN. */
export default function Welcome() {
  const r = useRouter();
  const t = useT();
  return (
    <div className="entry tall">
      <header className="art"><LeafArt /><Wave /></header>
      <main id="main" className="body">
        <h1>{t("welcome.title")}</h1>
        <p className="sub">{t("welcome.sub")}</p>
        <span className="accent" aria-hidden="true" />
        <button className="btn primary grad block pillbtn" onClick={() => { markWelcomeSeen(); r.push("/login"); }}>{t("welcome.cta")}</button>
      </main>
    </div>
  );
}
