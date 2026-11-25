import type { MetadataRoute } from "next";
import { MOBILE_THEME } from "@/lib/mobileTheme";

export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Chilli Staff", short_name: "Chilli Staff", description: "Waiter / captain ordering for the restaurant floor",
    start_url: "/", scope: "/", display: "standalone", orientation: "portrait",
    background_color: MOBILE_THEME.pageLight, theme_color: MOBILE_THEME.pageLight,
    // Owner app icon (design-system/brand): white rounded tile with the chilli mark.
    icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" }, { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" }],
  };
}
