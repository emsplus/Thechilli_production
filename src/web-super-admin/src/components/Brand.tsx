/* eslint-disable @next/next/no-img-element -- static brand PNGs in /public, already sized for 2x */
/** thechilli.ai wordmark (owner logo file): charcoal "the"/"ai" and red "chilli" (light theme only). */
export function Wordmark({ height = 28, className }: { height?: number; className?: string }) {
  return (
    <picture className={className}>
      <img src="/brand/logo-wordmark.png" alt="thechilli.ai" height={height} width={Math.round(height * 4.79)} style={{ display: "block" }} />
    </picture>
  );
}

/** The chilli mark with circuit lines (min 24px). Decorative when next to the wordmark. */
export function Mark({ size = 32, label }: { size?: number; label?: string }) {
  return <img src="/brand/logo-mark.png" alt={label ?? ""} width={Math.round(size * 1.77)} height={size} style={{ display: "block" }} />;
}

/** The wordmark for the white pill on the sign-in shape (always the light version: the pill is white in both themes). */
export function PillLogo() {
  return <img src="/brand/logo-wordmark.png" alt="" width={154} height={32} />;
}
