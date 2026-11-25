"use client";
import { useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";

/* Thin local copies of the @chilli/ui Input, Select, Button, Badge and Card markup (same ch-* classes, styled by @chilli/ui/styles.css).
 * @chilli/ui ships as one client barrel that drags Radix dialog/tabs into every page that imports it (~20 KB gz), which breaks the
 * 150 KB first-load budget on the form pages. Keep the markup identical so a tree-shakeable ui build can replace this file. */
interface FieldProps { label: string; hint?: string; error?: string }
const cx = (...a: (string | false | undefined)[]) => a.filter(Boolean).join(" ");

function Field({ id, label, hint, error, children }: FieldProps & { id: string; children: ReactNode }) {
  return (
    <div className="ch-field">
      <label className="ch-label" htmlFor={id}>{label}</label>
      {children}
      {hint && !error ? <p className="ch-hint" id={`${id}-hint`}>{hint}</p> : null}
      {error ? <p className="ch-error" id={`${id}-err`} role="alert">{error}</p> : null}
    </div>
  );
}
const described = (id: string, hint?: string, error?: string) => (error ? `${id}-err` : hint ? `${id}-hint` : undefined);

export function Input({ label, hint, error, id, className, ...rest }: FieldProps & Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & { id?: string }) {
  const auto = useId(); const fid = id ?? auto;
  return <Field id={fid} label={label} hint={hint} error={error}><input id={fid} className={cx("ch-input", className)} aria-invalid={error ? true : undefined} aria-describedby={described(fid, hint, error)} {...rest} /></Field>;
}
export function Select({ label, hint, error, id, className, children, ...rest }: FieldProps & Omit<SelectHTMLAttributes<HTMLSelectElement>, "id"> & { id?: string }) {
  const auto = useId(); const fid = id ?? auto;
  return <Field id={fid} label={label} hint={hint} error={error}><select id={fid} className={cx("ch-input", "ch-select", className)} aria-invalid={error ? true : undefined} aria-describedby={described(fid, hint, error)} {...rest}>{children}</select></Field>;
}
export function Button({ variant = "secondary", size = "md", loading, className, children, disabled, type = "button", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost"; size?: "sm" | "md" | "lg"; loading?: boolean }) {
  return <button type={type} className={cx("ch-btn", `ch-btn--${variant}`, `ch-btn--${size}`, className)} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>{loading ? <span className="ch-spinner" aria-hidden="true" /> : null}{children}</button>;
}
export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "primary" | "success" | "info"; children: ReactNode }) {
  return <span className={`ch-badge ch-badge--${tone}`}>{children}</span>;
}
export function Card({ as: Tag = "div", className, children, ...rest }: { as?: "div" | "section"; className?: string; children: ReactNode } & Omit<React.HTMLAttributes<HTMLElement>, "className">) {
  return <Tag className={cx("ch-card", className)} {...rest}>{children}</Tag>;
}
