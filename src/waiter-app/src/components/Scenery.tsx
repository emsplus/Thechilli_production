/**
 * Original entry-screen artwork: soft overlapping chilli-plant leaves, a small chilli and a few decorative marks, plus the wavy
 * white curve that separates the art from the card. Inline SVG, a few KB, colours come from CSS variables (--art-*), so dark mode dims it.
 * The leaves slice-fit (top anchored); the wave is stretched horizontally only, so its proportion is the same from 360 to 430 px wide.
 */
const LEAF = "M0 0C46 -70 52 -190 0 -300C-52 -190 -46 -70 0 0Z";
const RIB = "M0 -4L0 -250";

/** Large overlapping leaves; `tone` picks the palette class set (splash uses the same classes on its own gradient). */
export function LeafArt({ compact = false }: { compact?: boolean }) {
  return (
    <svg className="leafart" viewBox="0 0 360 480" preserveAspectRatio={compact ? "xMidYMid slice" : "xMidYMin slice"} aria-hidden="true" focusable="false">
      <defs>
        <g id="lf"><path d={LEAF} /><path className="rib" d={RIB} /></g>
      </defs>
      <g className="l3"><use href="#lf" transform="translate(10 330) rotate(52) scale(.8)" /></g>
      <g className="l1"><use href="#lf" transform="translate(40 500) rotate(26) scale(1.15)" /></g>
      <g className="l2"><use href="#lf" transform="translate(150 520) rotate(6) scale(1.3)" /></g>
      <g className="l1"><use href="#lf" transform="translate(250 530) rotate(-20) scale(1.25)" /></g>
      <g className="l3"><use href="#lf" transform="translate(340 470) rotate(-42) scale(.95)" /></g>
      <g className="l2"><use href="#lf" transform="translate(318 270) rotate(24) scale(.5)" /></g>
      {/* small chilli with a stem */}
      <g transform="translate(262 96) rotate(-14)">
        <path className="stem" d="M0 0C-4 -12 4 -22 14 -24C12 -14 14 -6 8 2Z" />
        <path className="pep" d="M0 0C16 -4 30 8 31 28C32 50 22 76 4 98C10 70 4 46 -8 28C-14 14 -8 2 0 0Z" />
      </g>
      <circle className="pep" cx="64" cy="70" r="7" opacity=".7" /><circle className="pep" cx="82" cy="86" r="4.5" opacity=".6" />
      <circle className="dec" cx="38" cy="150" r="9" />
      <path className="dec" d="M312 30l12 12M324 30l-12 12" />
      <path className="dec" d="M150 40l9-8 9 8 9-8" />
    </svg>
  );
}

/** The wavy white curve (card colour) with a paler band behind it. Sits at the bottom edge of `.art`. */
export function Wave() {
  return (
    <svg className="wave" viewBox="0 0 360 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <path className="band" d="M0 26C70 -4 150 12 220 46S330 86 360 78V100H0Z" />
      <path className="main" d="M0 46C80 14 160 30 232 62S328 98 360 92V100H0Z" />
    </svg>
  );
}

/** Four-point sparkle for the splash (decorative). */
export function Sparkle({ x, y, r = 10, delay = 0 }: { x: number; y: number; r?: number; delay?: number }) {
  const k = r * 0.12;
  return (
    <path className="sparkle" style={{ animationDelay: `${delay}s` }} fill="#fff"
      d={`M${x} ${y - r}C${x + k} ${y - k} ${x + k} ${y - k} ${x + r} ${y}C${x + k} ${y + k} ${x + k} ${y + k} ${x} ${y + r}C${x - k} ${y + k} ${x - k} ${y + k} ${x - r} ${y}C${x - k} ${y - k} ${x - k} ${y - k} ${x} ${y - r}Z`} />
  );
}
