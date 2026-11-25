import { cn } from "@/lib/cn";

/**
 * Original, lightweight inline-SVG illustrations in the "warm & clean" 2.5D style: a soft floor shadow, a lit top
 * face + darker side face, copper accents and tiny sparkles. All colours come from theme tokens (fill-* / stroke-*
 * and var(--...)), so they follow light/dark. Size with className (width). CSS animations (float, draw, steam)
 * stop under reduced motion / "Reduce effects".
 */
type P = { className?: string; title?: string };

function Svg({ className, title, children }: P & { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 160 120" fill="none" className={cn("h-auto w-full", className)} role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      {children}
    </svg>
  );
}

const Floor = ({ rx = 46 }: { rx?: number }) => <ellipse cx="80" cy="108" rx={rx} ry="6" className="fill-fg" opacity=".07" />;
const Sparkle = ({ x, y, s = 1, cls = "fill-primary-vivid", delay = "0s" }: { x: number; y: number; s?: number; cls?: string; delay?: string }) => (
  <g className="anim-float" style={{ transformOrigin: `${x}px ${y}px`, animationDelay: delay }}>
    <path d={`M${x} ${y - 5 * s}q${1 * s} ${4 * s} ${5 * s} ${5 * s}q${-4 * s} ${1 * s} ${-5 * s} ${5 * s}q${-1 * s} ${-4 * s} ${-5 * s} ${-5 * s}q${4 * s} ${-1 * s} ${5 * s} ${-5 * s}z`} className={cls} />
  </g>
);

export function EmptyCartIllustration(p: P) {
  return (
    <Svg {...p}>
      <Floor />
      <g className="anim-float" style={{ transformOrigin: "80px 60px" }}>
        {/* basket: side face, then lit front */}
        <path d="M54 50h60l-7 26H62z" className="fill-primary-soft" />
        <path d="M58 54h52l-5 18H64z" style={{ fill: "var(--surface)" }} opacity=".55" />
        <path d="M42 36h9l11 40h44l8-26" className="stroke-fg-muted" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M70 58h8M86 58h8" className="stroke-primary" strokeWidth="3" strokeLinecap="round" opacity=".5" />
        <circle cx="68" cy="89" r="6.5" className="fill-surface stroke-primary" strokeWidth="4" />
        <circle cx="102" cy="89" r="6.5" className="fill-surface stroke-primary" strokeWidth="4" />
      </g>
      <Sparkle x={122} y={30} />
      <Sparkle x={36} y={50} s={0.7} cls="fill-warning" delay="-1.5s" />
      <circle cx="128" cy="56" r="2.5" className="fill-primary" opacity=".5" />
    </Svg>
  );
}

export function EmptyMenuIllustration(p: P) {
  return (
    <Svg {...p}>
      <Floor rx={40} />
      {/* menu card with a lifted back sheet */}
      <rect x="52" y="20" width="66" height="84" rx="10" className="fill-surface-3" transform="rotate(6 85 62)" />
      <rect x="44" y="16" width="68" height="88" rx="10" className="fill-surface stroke-border-strong" strokeWidth="2" />
      <rect x="54" y="27" width="28" height="7" rx="3.5" className="fill-primary" />
      <g className="stroke-fg-subtle" strokeWidth="3.5" strokeLinecap="round" opacity=".55"><path d="M54 48h46M54 60h34M54 72h40" /></g>
      <g className="anim-float" style={{ transformOrigin: "106px 88px" }}>
        <circle cx="106" cy="88" r="15" className="fill-primary" />
        <circle cx="106" cy="88" r="15" style={{ fill: "var(--primary-vivid)" }} opacity=".35" />
        <path d="M100 88h12M106 82v12" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" />
      </g>
      <Sparkle x={128} y={28} cls="fill-warning" />
    </Svg>
  );
}

export function OfflineCloudIllustration(p: P) {
  return (
    <Svg {...p}>
      <Floor rx={42} />
      <g className="anim-float" style={{ transformOrigin: "80px 56px" }}>
        <path d="M50 80a17 17 0 0 1 3-33 25 25 0 0 1 47-4 19 19 0 0 1 9 37z" className="fill-surface-3" transform="translate(3 4)" />
        <path d="M50 80a17 17 0 0 1 3-33 25 25 0 0 1 47-4 19 19 0 0 1 9 37z" className="fill-surface stroke-border-strong" strokeWidth="2" />
        <path d="M70 64a14 14 0 0 1 20 0M76 71a6 6 0 0 1 8 0" className="stroke-fg-subtle" strokeWidth="3.5" strokeLinecap="round" opacity=".6" />
        <path d="M60 88l40-50" className="stroke-warning" strokeWidth="5" strokeLinecap="round" />
      </g>
      <Sparkle x={124} y={30} s={0.8} cls="fill-warning" />
    </Svg>
  );
}

export function EmptyReportIllustration(p: P) {
  return (
    <Svg {...p}>
      <Floor rx={50} />
      <rect x="36" y="22" width="96" height="80" rx="12" className="fill-surface-3" transform="translate(4 4)" />
      <rect x="32" y="18" width="96" height="80" rx="12" className="fill-surface stroke-border-strong" strokeWidth="2" />
      <g>
        <rect x="48" y="64" width="14" height="22" rx="4" className="fill-primary-soft" />
        <rect x="70" y="50" width="14" height="36" rx="4" className="fill-primary" opacity=".55" />
        <rect x="92" y="36" width="14" height="50" rx="4" className="fill-primary" />
        <rect x="92" y="36" width="5" height="50" rx="2.5" style={{ fill: "var(--primary-vivid)" }} opacity=".45" />
      </g>
      <path d="M44 38l24 6 22-14 30 4" className="stroke-warning anim-draw" pathLength={1} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <Sparkle x={134} y={20} />
    </Svg>
  );
}

export function StockBoxIllustration(p: P) {
  return (
    <Svg {...p}>
      <Floor />
      {/* isometric crate: lit top, warm left face, shaded right face */}
      <path d="M40 46l40-18 40 18-40 18z" className="fill-surface" />
      <path d="M40 46l40 18v42L40 88z" className="fill-primary-soft" />
      <path d="M120 46l-40 18v42l40-18z" className="fill-surface-3" />
      <path d="M40 46l40-18 40 18v42l-40 18-40-18z M40 46l40 18 40-18M80 64v42" className="stroke-border-strong" strokeWidth="2" strokeLinejoin="round" />
      <path d="M60 37l40 18v14" className="stroke-primary" strokeWidth="4" strokeLinecap="round" />
      <g className="anim-float" style={{ transformOrigin: "118px 26px" }}><circle cx="118" cy="26" r="5" className="fill-warning" /></g>
      <Sparkle x={36} y={30} s={0.7} />
    </Svg>
  );
}

export function ChatAssistantIllustration(p: P) {
  return (
    <Svg {...p}>
      <Floor rx={44} />
      <path d="M36 28h66a10 10 0 0 1 10 10v26a10 10 0 0 1-10 10H62l-14 12V74h-12a10 10 0 0 1-10-10V38a10 10 0 0 1 10-10z" className="fill-surface-3" transform="translate(3 3)" />
      <path d="M36 28h66a10 10 0 0 1 10 10v26a10 10 0 0 1-10 10H62l-14 12V74h-12a10 10 0 0 1-10-10V38a10 10 0 0 1 10-10z" className="fill-surface stroke-border-strong" strokeWidth="2" strokeLinejoin="round" />
      <g className="fill-primary"><circle cx="54" cy="51" r="4.5" /><circle cx="70" cy="51" r="4.5" opacity=".7" /><circle cx="86" cy="51" r="4.5" opacity=".4" /></g>
      <path d="M104 62h14a8 8 0 0 1 8 8v14a8 8 0 0 1-8 8h-4v10l-10-10h-8a8 8 0 0 1-8-8V70a8 8 0 0 1 8-8z" className="fill-primary" />
      <path d="M104 62h14a8 8 0 0 1 8 8v4H96v-4a8 8 0 0 1 8-8z" style={{ fill: "var(--primary-vivid)" }} opacity=".45" />
      <Sparkle x={130} y={26} cls="fill-warning" />
      <Sparkle x={30} y={22} s={0.6} delay="-2s" />
    </Svg>
  );
}

/** Animated success tick (draws itself). Good for "Payment complete"; pair with <SuccessBurst>. */
export function SuccessCheckIllustration({ className, title }: P) {
  return (
    <svg viewBox="0 0 120 120" fill="none" className={cn("h-auto w-full", className)} role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <circle cx="60" cy="64" r="44" className="fill-fg" opacity=".05" />
      <circle cx="60" cy="60" r="44" className="fill-success-soft" />
      <circle cx="60" cy="60" r="44" className="stroke-success anim-draw" pathLength={1} strokeWidth="5" strokeLinecap="round" />
      <path d="M40 62l14 14 28-32" className="stroke-success anim-draw" pathLength={1} strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" style={{ animationDelay: "450ms" }} />
    </svg>
  );
}
