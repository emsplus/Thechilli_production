import * as RT from '@radix-ui/react-tabs';
import { forwardRef, useId, useState, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { cx } from './cx';
import { Field, describedBy, type FieldProps } from './field';
import { NumberStepper } from './forms';

type Omit2<T, K extends string> = Omit<T, K>;

interface ToggleProps extends Omit2<InputHTMLAttributes<HTMLInputElement>, 'type' | 'id' | 'size'> {
  label: string;
  hint?: string;
  error?: string;
  id?: string;
}

function Toggle({ kind, label, hint, error, id, className, ...rest }: ToggleProps & { kind: 'checkbox' | 'switch' }, ref: React.Ref<HTMLInputElement>) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <div className="ch-field">
      <label className="ch-check" htmlFor={fid}>
        <input
          ref={ref}
          id={fid}
          type="checkbox"
          role={kind === 'switch' ? 'switch' : undefined}
          className={cx('ch-check__box', kind === 'switch' && 'ch-check__box--switch', className)}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(fid, hint, error)}
          {...rest}
        />
        <span>{label}</span>
      </label>
      {hint && !error ? <p className="ch-hint" id={`${fid}-hint`}>{hint}</p> : null}
      {error ? <p className="ch-error" id={`${fid}-err`} role="alert">{error}</p> : null}
    </div>
  );
}

/** Checkbox: whole row (label included) is the 44px+ target. Native input, so Space toggles. */
export const Checkbox = forwardRef<HTMLInputElement, ToggleProps>(function Checkbox(props, ref) {
  return Toggle({ ...props, kind: 'checkbox' }, ref);
});

/** Switch: an instant on/off setting (role=switch). Use Checkbox for things that need a Save. */
export const Switch = forwardRef<HTMLInputElement, ToggleProps>(function Switch(props, ref) {
  return Toggle({ ...props, kind: 'switch' }, ref);
});

export interface Option { value: string; label: string; disabled?: boolean }

interface ChoiceProps {
  /** Group name read by assistive tech (fieldset legend / radiogroup label). */
  legend: string;
  options: Option[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  name?: string;
  hint?: string;
  error?: string;
}

function useChoice({ value, defaultValue, onValueChange }: Pick<ChoiceProps, 'value' | 'defaultValue' | 'onValueChange'>) {
  const [inner, setInner] = useState(defaultValue);
  const current = value ?? inner;
  return [current, (v: string) => { setInner(v); onValueChange?.(v); }] as const;
}

/** Radio group: native radios in a fieldset, so arrows, Tab and grouping are free. */
export function RadioGroup(props: ChoiceProps & { orientation?: 'vertical' | 'horizontal' }) {
  const { legend, options, name, hint, error, orientation = 'vertical' } = props;
  const [current, set] = useChoice(props);
  const auto = useId();
  const gname = name ?? auto;
  return (
    <fieldset className="ch-fieldset" aria-describedby={describedBy(gname, hint, error)} aria-invalid={error ? true : undefined}>
      <legend className="ch-label">{legend}</legend>
      <div className={cx('ch-choices', orientation === 'horizontal' && 'ch-choices--row')}>
        {options.map((o) => (
          <label key={o.value} className="ch-check">
            <input type="radio" className="ch-check__box ch-check__box--radio" name={gname} value={o.value} disabled={o.disabled} checked={current === o.value} onChange={() => set(o.value)} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
      {hint && !error ? <p className="ch-hint" id={`${gname}-hint`}>{hint}</p> : null}
      {error ? <p className="ch-error" id={`${gname}-err`} role="alert">{error}</p> : null}
    </fieldset>
  );
}

/** Segmented control: 2-5 mutually exclusive views or modes (radiogroup semantics, arrow keys). */
export function SegmentedControl({ legend, options, name, ...rest }: Omit2<ChoiceProps, 'hint' | 'error'>) {
  const [current, set] = useChoice(rest);
  const auto = useId();
  return (
    <div role="radiogroup" aria-label={legend} className="ch-seg">
      {options.map((o) => (
        <label key={o.value} className="ch-seg__opt">
          <input type="radio" name={name ?? auto} value={o.value} disabled={o.disabled} checked={current === o.value} onChange={() => set(o.value)} />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

export interface TextareaProps extends FieldProps, Omit2<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> {
  id?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hint, error, id, className, rows = 3, ...rest },
  ref,
) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <Field id={fid} label={label} hint={hint} error={error}>
      <textarea ref={ref} id={fid} rows={rows} className={cx('ch-input', 'ch-textarea', className)} aria-invalid={error ? true : undefined} aria-describedby={describedBy(fid, hint, error)} {...rest} />
    </Field>
  );
});

/** Local-time yyyy-mm-dd (what <input type=date> reads and writes). Not toISOString, which is UTC. */
export function toISODate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface DateInputProps extends FieldProps, Omit2<InputHTMLAttributes<HTMLInputElement>, 'id' | 'type'> {
  id?: string;
}

/** Native date picker: best keyboard and screen reader support on cheap Android. Value is yyyy-mm-dd. */
export const DateInput = forwardRef<HTMLInputElement, DateInputProps>(function DateInput(
  { label, hint, error, id, className, ...rest },
  ref,
) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <Field id={fid} label={label} hint={hint} error={error}>
      <input ref={ref} id={fid} type="date" className={cx('ch-input', className)} aria-invalid={error ? true : undefined} aria-describedby={describedBy(fid, hint, error)} {...rest} />
    </Field>
  );
});

export interface PillTabItem { value: string; label: string; count?: number; content?: ReactNode }

/** Pill tabs: filter-style tabs (All / Open / Late) with optional counts. Radix handles roving focus. */
export function PillTabs({ items, value, defaultValue, onValueChange, label }: {
  items: PillTabItem[]; value?: string; defaultValue?: string; onValueChange?: (v: string) => void; label: string;
}) {
  return (
    <RT.Root value={value} defaultValue={value === undefined ? (defaultValue ?? items[0]?.value) : undefined} onValueChange={onValueChange}>
      <RT.List className="ch-pills" aria-label={label}>
        {items.map((i) => (
          <RT.Trigger key={i.value} value={i.value} className="ch-pills__tab">
            {i.label}
            {i.count !== undefined ? <span className="ch-pills__count">{i.count}</span> : null}
          </RT.Trigger>
        ))}
      </RT.List>
      {items.map((i) => (i.content === undefined ? null : <RT.Content key={i.value} value={i.value} className="ch-tabs__panel">{i.content}</RT.Content>))}
    </RT.Root>
  );
}

/** Quantity stepper for order lines. Same component as NumberStepper (44px targets, arrow keys, typed entry). */
export const QtyStepper = NumberStepper;
