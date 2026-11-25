/** thechilli.ai wordmark (owner logo file): charcoal "the"/"ai" and red "chilli" (light theme only). */
export function Wordmark({ height = 28, className }: { height?: number; className?: string }) {
  return (
    <picture className={className}>
      <img src="/brand/logo-wordmark.png" alt="thechilli.ai" height={height} width={Math.round(height * 4.79)} style={{ display: "block" }} />
    </picture>
  );
}
