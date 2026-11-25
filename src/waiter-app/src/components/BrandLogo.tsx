/**
 * THE single place the Chilli logo is rendered (splash, welcome, anywhere else a logo is needed).
 * Owner's brand mark (design-system/brand/logo-mark.png, resized to 352 px for 2x screens) on a white rounded tile: the brand
 * guide puts the red chilli on white, never directly on red or dark surfaces. Keep the `size` prop and the accessible name.
 */
export function BrandLogo({ size = 120, className }: { size?: number; className?: string }) {
  return (
    <span
      role="img"
      aria-label="Chilli"
      className={`brand-badge${className ? ` ${className}` : ""}`}
      style={{ width: size, height: size, borderRadius: size * 0.3 }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- static export, no image optimiser */}
      <img src="/brand/logo-mark.png" alt="" width={352} height={198} decoding="async" />
    </span>
  );
}
