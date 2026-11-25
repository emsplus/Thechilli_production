import { registerPlugin } from "@capacitor/core";

/**
 * Native colour behind the system bars / the web view edges. iOS (ios/App/App/SceneDelegate.swift): `apply()` switches the red
 * launch background to the dynamic page colour. Android (android/.../PageBackgroundPlugin.java): `set({ color })` paints the window
 * behind the transparent status and navigation bars, since the app is edge to edge and `StatusBar.setBackgroundColor` has no
 * effect there. Calls fail (and are ignored) where the plugin does not exist, so callers never need a platform check.
 */
export const PageBackground = registerPlugin<{ apply(): Promise<void>; set(o: { color: string }): Promise<void> }>("PageBackground");
