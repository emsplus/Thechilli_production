import { type KeyboardEvent } from 'react';
import { cx } from './cx';
import { icons } from './icons';
import { t, type Locale } from './locale';
import { formatINR, parseRupees, type MoneyInput } from './money';

export interface KeypadProps {
  /** Typed rupees as text ("500", "99.5"). Controlled. */
  value: string;
  onChange: (value: string) => void;
  /** Bill total in paise. When set, shows Change (or Short by) live. */
  total?: MoneyInput;
  /** Quick cash amounts in rupees; one tap sets the tendered amount exactly. */
  quick?: number[];
  /** Adds a "." key (max 2 decimals). Default false: whole rupees. */
  allowDecimal?: boolean;
  /** Longest allowed text. Default 9 (up to 9 crore). */
  maxLength?: number;
  label?: string;
  locale?: Locale;
  /** Currency symbol shown instead of ₹ (amounts keep Indian grouping), e.g. "£" or "AED ". Ignored when `format` is set. */
  currency?: string;
  /** Full control over amount text: receives integer minor units and whether decimals were typed. Wins over `currency`. */
  format?: (paise: bigint, alwaysDecimals: boolean) => string;
}

/** Numeric pad for cash tendering. Big keys, physical keyboard works, change shown as you type. */
export function Keypad({ value, onChange, total, quick, allowDecimal = false, maxLength = 9, label = 'Keypad', locale = 'en', currency, format }: KeypadProps) {
  const fmt = (paise: bigint, alwaysDecimals: boolean) =>
    format ? format(paise, alwaysDecimals) : currency !== undefined ? formatINR(paise, { alwaysDecimals }).replace('₹', currency) : formatINR(paise, { alwaysDecimals });
  const amount = (paise: bigint, alwaysDecimals = false) => <span translate="no" className="ch-money">{fmt(paise, alwaysDecimals)}</span>;
  const press = (k: string) => {
    let next: string;
    if (k === '.') {
      if (!allowDecimal || value.includes('.')) return;
      next = `${value || '0'}.`;
    } else if (value === '' || value === '0') {
      if (k === '0' || k === '00') return;
      next = k;
    } else next = value + k;
    if (next.length > maxLength || parseRupees(next) === null) return;
    onChange(next);
  };
  const back = () => onChange(value.slice(0, -1));
  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^\d$/.test(e.key) || (e.key === '.' && allowDecimal)) { e.preventDefault(); press(e.key); }
    else if (e.key === 'Backspace') { e.preventDefault(); back(); }
    else if (e.key === 'Escape' && value) { e.preventDefault(); e.stopPropagation(); onChange(''); }
  };

  const tendered = parseRupees(value) ?? 0n;
  const totalPaise = total === undefined ? null : BigInt(Math.round(Number(total)));
  const diff = totalPaise === null ? null : tendered - totalPaise;
  const key = (k: string, cls?: string) => (
    <button key={k} type="button" className={cx('ch-btn ch-btn--secondary ch-keypad__key', cls)} onClick={() => press(k)}>{k}</button>
  );

  return (
    // The group handles typed digits so a cashier with a keyboard never has to click keys.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div className="ch-keypad" role="group" aria-label={label} onKeyDown={onKey}>
      <div className="ch-keypad__display" role="status" aria-live="polite">
        <div className="ch-keypad__row"><span>{t(locale, 'pad.tendered')}</span><strong>{amount(tendered, value.includes('.'))}</strong></div>
        {diff !== null ? (
          <div className={cx('ch-keypad__row', diff < 0n && 'ch-keypad__row--short')}>
            <span>{t(locale, diff < 0n ? 'pad.short' : 'pad.change')}</span>
            <strong>{amount(diff < 0n ? -diff : diff, value.includes('.'))}</strong>
          </div>
        ) : null}
      </div>
      {quick?.length ? (
        <div className="ch-keypad__quick">
          {quick.map((r) => (
            <button key={r} type="button" className="ch-btn ch-btn--secondary" onClick={() => onChange(String(r))}>{amount(BigInt(r) * 100n)}</button>
          ))}
        </div>
      ) : null}
      <div className="ch-keypad__grid">
        {['7', '8', '9', '4', '5', '6', '1', '2', '3'].map((k) => key(k))}
        {allowDecimal ? key('.') : key('00')}
        {key('0')}
        <button type="button" className="ch-btn ch-btn--secondary ch-keypad__key" aria-label={t(locale, 'pad.back')} onClick={back} disabled={value === ''}>{icons.back}</button>
      </div>
      <button type="button" className="ch-btn ch-btn--ghost ch-keypad__clear" onClick={() => onChange('')} disabled={value === ''}>{t(locale, 'pad.clear')}</button>
    </div>
  );
}
