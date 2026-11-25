import type { ReactNode } from 'react';

/** Shared label + hint + error wrapper for every form control (not part of the public API). */
export interface FieldProps {
  label: string;
  hint?: string;
  /** Inline error: announced via role=alert, says the fix. */
  error?: string;
}

export function Field({ id, label, hint, error, children }: FieldProps & { id: string; children: ReactNode }) {
  return (
    <div className="ch-field">
      <label className="ch-label" htmlFor={id}>{label}</label>
      {children}
      {hint && !error ? <p className="ch-hint" id={`${id}-hint`}>{hint}</p> : null}
      {error ? <p className="ch-error" id={`${id}-err`} role="alert">{error}</p> : null}
    </div>
  );
}

export const describedBy = (id: string, hint?: string, error?: string) =>
  error ? `${id}-err` : hint ? `${id}-hint` : undefined;
