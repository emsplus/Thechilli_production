import { BrandLogo } from "@/components/BrandLogo";
import { LeafArt } from "@/components/Scenery";
import { useT } from "@/lib/i18n";

/** Full-screen Chilli Red splash: the leaf artwork, the logo in the middle, app name at the bottom. */
export function Splash() {
  const t = useT();
  return (
    // A landmark with the skip link's target: the splash is the whole page while it shows (axe: region, skip-link).
    <main id="main" className="splash" aria-busy="true">
      <LeafArt />
      <div className="logo-wrap"><BrandLogo size={132} /></div>
      <p className="name" role="status">{t("app.name")}</p>
    </main>
  );
}
