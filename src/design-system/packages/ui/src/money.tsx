import type { HTMLAttributes } from 'react';

export type MoneyInput = bigint | number;

export interface FormatOptions {
  /** Abbreviate to lakh / crore: 123456700 paise -> ₹12.3 L */
  compact?: boolean;
  /** Always show 2 decimals (bills). Default false: whole rupees when paise = 0. */
  alwaysDecimals?: boolean;
}

/** Groups digits the Indian way: 1234567 -> 12,34,567 */
export function groupIndian(intDigits: string): string {
  if (intDigits.length <= 3) return intDigits;
  const last3 = intDigits.slice(-3);
  const rest = intDigits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${rest},${last3}`;
}

/** Truncates (never rounds up, so 9,99,999 shows ₹9.9 L, not ₹10 L). Integer math, no floats. */
function oneDecimal(rupees: bigint, unit: bigint): string {
  const tenths = (rupees * 10n) / unit;
  const whole = tenths / 10n;
  const d = tenths % 10n;
  return d === 0n ? `${whole}` : `${whole}.${d}`;
}

/**
 * Formats integer paise (minor units) as rupees. Never uses floats for the grouped
 * amount, so it is safe for BigInt money. Negative values use a real minus sign.
 */
export function formatINR(paise: MoneyInput, opts: FormatOptions = {}): string {
  const p = typeof paise === 'bigint' ? paise : BigInt(Math.round(paise));
  const neg = p < 0n;
  const abs = neg ? -p : p;
  const sign = neg ? '−' : '';

  if (opts.compact) {
    const rupees = abs / 100n;
    if (rupees >= 10_000_000n) return `${sign}₹${oneDecimal(rupees, 10_000_000n)} Cr`;
    if (rupees >= 100_000n) return `${sign}₹${oneDecimal(rupees, 100_000n)} L`;
  }
  const whole = (abs / 100n).toString();
  const frac = Number(abs % 100n);
  const decimals = opts.alwaysDecimals || frac !== 0 ? `.${String(frac).padStart(2, '0')}` : '';
  return `${sign}₹${groupIndian(whole)}${decimals}`;
}

export interface MoneyProps extends FormatOptions, Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  /** Amount in paise (minor units). */
  value: MoneyInput;
}

/** Tabular, never animated, never translated. */
export function Money({ value, compact, alwaysDecimals, className, ...rest }: MoneyProps) {
  return (
    <span {...rest} translate="no" className={['ch-money', className].filter(Boolean).join(' ')}>
      {formatINR(value, { compact, alwaysDecimals })}
    </span>
  );
}

/**
 * Parses a typed rupee amount ("1250", "99.5", "0.05") into integer paise without floats.
 * Returns null for anything that is not digits with at most 2 decimals.
 */
export function parseRupees(text: string): bigint | null {
  const m = /^(\d*)(?:\.(\d{0,2}))?$/.exec(text.trim());
  if (!m || (m[1] === '' && !m[2])) return null;
  return BigInt(m[1] || '0') * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0');
}
