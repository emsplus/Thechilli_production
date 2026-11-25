import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cx } from './cx';

export type ButtonVariant = 'primary' | 'secondary' | 'ink' | 'ghost' | 'danger-soft' | 'danger' | 'danger-solid';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'pay';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  iconStart?: ReactNode;
}

/** Plain <button>. Exactly one `primary` per view (P8). `danger` (red outline) starts an irreversible action and always opens a confirm dialog; `danger-solid` (filled) is that dialog's confirm button. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, iconStart, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx('ch-btn', `ch-btn--${variant}`, `ch-btn--${size}`, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="ch-spinner" aria-hidden="true" /> : iconStart}
      {children}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> {
  /** Required: icon-only buttons must have an accessible name. */
  label: string;
  icon: ReactNode;
  variant?: Exclude<ButtonVariant, 'primary'>;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, variant = 'ghost', className, type = 'button', ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} aria-label={label} title={label} className={cx('ch-btn', 'ch-btn--icon', `ch-btn--${variant}`, className)} {...rest}>
      {icon}
    </button>
  );
});
