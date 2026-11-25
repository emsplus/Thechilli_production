import { cn } from "@/lib/cn";

const DIGITS = "0123456789";

/**
 * Odometer-style number: each digit rolls vertically to its new value (CSS transform transition, no JS loop).
 * Pass the exact display string ("1,234.50"); it is what screen readers and tests read (sr-only copy), so the
 * animation can never show a wrong final value. Disabled under reduced motion / "Reduce effects".
 *   <NumberRoll value={formatMoney(total)} prefix="₹" className="text-2xl font-bold" />
 */
export function NumberRoll({ value, prefix, className, prefixClassName }: {
  value: string | number;
  prefix?: string;
  className?: string;
  prefixClassName?: string;
}) {
  const text = String(value);
  const word = !!prefix && /[A-Za-z]/.test(prefix); // a word prefix gets a gap, "₹" hugs the number
  const chars = [...text];
  return (
    <span className={cn("tnum relative inline-flex items-baseline whitespace-nowrap", className)}>
      <span className="sr-only">{prefix ? `${prefix}${word ? " " : ""}${text}` : text}</span>
      {prefix && <span aria-hidden className={cn(word ? "mr-[0.3em]" : "mr-[0.06em]", "text-[0.62em] font-semibold text-fg-subtle", prefixClassName)}>{prefix}</span>}
      <span aria-hidden className="inline-flex overflow-hidden leading-[1.15]">
        {chars.map((c, i) => {
          // Key from the right so "9.50" -> "10.50" keeps the decimals in place and rolls the integer part.
          const key = chars.length - i;
          const d = DIGITS.indexOf(c);
          if (d < 0) return <span key={`s${key}`}>{c}</span>;
          return (
            <span key={`d${key}`} className="relative inline-block h-[1.15em] overflow-hidden">
              <span className="invisible">{c}</span>
              <span className="roll-strip absolute inset-x-0 top-0 flex flex-col" style={{ transform: `translateY(${-d * 1.15}em)` }}>
                {[...DIGITS].map((x) => <span key={x} className="block h-[1.15em] text-center">{x}</span>)}
              </span>
            </span>
          );
        })}
      </span>
    </span>
  );
}
