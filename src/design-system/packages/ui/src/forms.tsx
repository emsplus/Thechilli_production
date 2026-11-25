import { forwardRef, useId, useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type KeyboardEvent } from 'react';
import { icons } from './icons';
import { cx } from './cx';
import { t, type Locale } from './locale';
import { Field, describedBy, type FieldProps } from './field';

export interface InputProps extends FieldProps, Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  id?: string;
  /** `pill`: fully rounded 52px field with a grey label (sign-in screens; needs `@chilli/ui/auth.css`). */
  variant?: 'default' | 'pill';
  /** Decorative leading icon inside the field (e.g. `icons.mail`). */
  icon?: ReactNode;
  /** Control at the end of the field (e.g. a show/hide button); the field reserves 48px for it. */
  end?: ReactNode;
}

/** Visible label always required (no placeholder-only fields). Font size >= 16 to avoid mobile zoom. */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, id, className, variant, icon, end, ...rest },
  ref,
) {
  const auto = useId();
  const fid = id ?? auto;
  const input = (
    <input
      ref={ref}
      id={fid}
      className={cx('ch-input', variant === 'pill' && 'ch-input--pill', icon != null && 'ch-input--icon', end != null && 'ch-input--end', className)}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy(fid, hint, error)}
      {...rest}
    />
  );
  return (
    <Field id={fid} label={label} hint={hint} error={error}>
      {icon != null || end != null ? (
        <div className="ch-input-wrap">
          {icon != null ? <span className="ch-input-wrap__icon" aria-hidden="true">{icon}</span> : null}
          {input}
          {end != null ? <span className="ch-input-wrap__end">{end}</span> : null}
        </div>
      ) : input}
    </Field>
  );
});

export interface PasswordInputProps extends Omit<InputProps, 'type' | 'end'> {
  /** Accessible names of the eye button (not "password", so getByLabel('Password') still finds only the field). */
  showLabel?: string;
  hideLabel?: string;
}

/** Password field with a leading lock and a show/hide (eye) button: a real 44px toggle button with aria-pressed. */
export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(function PasswordInput(
  { showLabel = 'Show characters', hideLabel = 'Hide characters', icon = icons.lock, ...rest },
  ref,
) {
  const [shown, setShown] = useState(false);
  return (
    <Input
      ref={ref}
      {...rest}
      icon={icon}
      type={shown ? 'text' : 'password'}
      end={
        <button type="button" className="ch-input-eye" aria-label={shown ? hideLabel : showLabel} aria-pressed={shown} onClick={() => setShown((v) => !v)}>
          {shown ? icons.eyeOff : icons.eye}
        </button>
      }
    />
  );
});

export interface SelectProps extends FieldProps, Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  id?: string;
}

/** Native select: fastest and most accessible on cheap Android. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hint, error, id, className, children, ...rest },
  ref,
) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <Field id={fid} label={label} hint={hint} error={error}>
      <select
        ref={ref}
        id={fid}
        className={cx('ch-input', 'ch-select', className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(fid, hint, error)}
        {...rest}
      >
        {children}
      </select>
    </Field>
  );
});

export interface NumberStepperProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  locale?: Locale;
  /** Hide the visible label but keep it for assistive tech (e.g. inside a cart line). */
  hideLabel?: boolean;
  error?: string;
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** Quantity stepper: 44px targets, keyboard arrows, typed entry. */
export function NumberStepper({
  label, value, onChange, min = 0, max = 999, step = 1, locale = 'en', hideLabel, error,
}: NumberStepperProps) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (n: number) => onChange(clamp(n, min, max));
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowUp') { e.preventDefault(); commit(value + step); }
    if (e.key === 'ArrowDown') { e.preventDefault(); commit(value - step); }
  };
  return (
    <div className="ch-field">
      <label className={cx('ch-label', hideLabel && 'ch-sr-only')} htmlFor={id}>{label}</label>
      <div className="ch-stepper" role="group" aria-label={label}>
        <button type="button" className="ch-btn ch-btn--secondary ch-btn--icon" aria-label={t(locale, 'qty.decrease', { label })} disabled={value <= min} onClick={() => commit(value - step)}>
          <span aria-hidden="true">{'−'}</span>
        </button>
        <input
          id={id}
          className="ch-input ch-stepper__value"
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          role="spinbutton"
          aria-valuenow={value}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-invalid={error ? true : undefined}
          value={draft ?? String(value)}
          onChange={(e) => setDraft(e.target.value.replace(/\D/g, ''))}
          onBlur={() => { if (draft !== null) { commit(draft === '' ? min : Number(draft)); setDraft(null); } }}
          onKeyDown={onKey}
        />
        <button type="button" className="ch-btn ch-btn--secondary ch-btn--icon" aria-label={t(locale, 'qty.increase', { label })} disabled={value >= max} onClick={() => commit(value + step)}>
          <span aria-hidden="true">+</span>
        </button>
      </div>
      {error ? <p className="ch-error" role="alert">{error}</p> : null}
    </div>
  );
}
