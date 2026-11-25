import { Splash } from "@/components/Splash";

/**
 * What the static HTML of every screen paints first, before JS, storage reads or auth hydration (no blank cream page on
 * a cold start): the same orange splash as "/", so launch screen -> splash -> app has no flash in between.
 */
export const BootScreen = Splash;
