import { KeyboardResize } from "@capacitor/keyboard";
import type { CapacitorConfig } from "@capacitor/cli";

// Debug builds (scripts/android-build.sh debug) set CHILLI_DEV_NATIVE_HTTP=1: fetch goes through Capacitor's native HTTP
// stack, which has no CORS and no https-page mixed-content rule, so the app can reach http://10.0.2.2:8000 without
// touching pos-service CORS_ORIGINS. Release builds keep the WebView fetch (origin https://localhost, API must be https
// and allow that origin in CORS_ORIGINS) -- see docs/ANDROID.md.
const devNativeHttp = process.env.CHILLI_DEV_NATIVE_HTTP === "1";

// Owner / manager open the Business app inside this WebView (src/lib/adminUrl.ts); its host must be allowed to navigate in-app.
const adminHost = (() => { try { return process.env.NEXT_PUBLIC_ADMIN_URL ? new URL(process.env.NEXT_PUBLIC_ADMIN_URL).host : ""; } catch { return ""; } })();

const config: CapacitorConfig = {
  appId: "in.chilli.staff",
  appName: "Chilli Staff",
  // Static export of the Next app (see docs/ANDROID.md). Produced by `pnpm build:native`.
  webDir: "out",
  // Web view background before the first paint: Chilli Red, so even a slow WebView start never shows a blank page.
  backgroundColor: "#e50914",
  // Debug only: dish photos are <img> tags, which CapacitorHttp does not proxy; the page must be allowed to load
  // http://10.0.2.2:8000/media/... (the debug network_security_config permits cleartext to that host only). Release: off.
  // minWebViewVersion 85 = the oldest Chrome the app's JS runs on (package.json browserslist). Below it Capacitor opens
  // public/webview-update.html ("update Android System WebView in Play Store") instead of a splash that never ends.
  android: { allowMixedContent: devNativeHttp, minWebViewVersion: 85 },
  // iOS WKWebView cannot serve http(s) from a custom handler, so the origin is capacitor://localhost (see docs/IOS.md).
  // Android debug: WebView 113 still blocked http images under https://localhost with mixed content allowed, so debug builds
  // serve the app from http://localhost (still a secure context: WebCrypto for the MPIN vault works).
  server: { iosScheme: "capacitor", errorPath: "webview-update.html", ...(adminHost ? { allowNavigation: [adminHost] } : {}), ...(devNativeHttp ? { androidScheme: "http" } : {}) },
  // contentInset "never": the CSS already pads with env(safe-area-inset-*) (viewport-fit=cover); "always" doubled the top gap.
  // No iOS-only background: the shared Chilli Red shows until the splash HTML paints (a cream one flashed blank before).
  ios: { contentInset: "never" },
  plugins: {
    ...(devNativeHttp ? { CapacitorHttp: { enabled: true } } : {}),
    // The native launch screen stays until NativeBootstrap hides it from JS (the static splash HTML is painted by then):
    // auto-hiding after a fixed delay showed a blank web view for seconds on slow cold starts (measured on iOS).
    SplashScreen: { launchAutoHide: false, backgroundColor: "#e50914", androidScaleType: "CENTER_INSIDE", showSpinner: false },
    Keyboard: { resize: KeyboardResize.Body, resizeOnFullScreen: true },
    StatusBar: { backgroundColor: "#e50914", style: "DARK" },
  },
};
export default config;
