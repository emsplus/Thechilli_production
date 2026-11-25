"use client";

import { useId, type ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import { cn } from "@/lib/cn";

export interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  /** Error message (e.g. `errors.email?.message` from react-hook-form). */
  error?: string;
  className?: string;
}

/** Wires label / hint / error to a control via ids. `render` receives the aria props to spread. */
export function FieldShell({
  label, hint, error, className, required, render,
}: FieldProps & { required?: boolean; render: (a: { id: string; "aria-invalid"?: true; "aria-describedby"?: string }) => ReactNode }) {
  const uid = useId();
  const id = `f${uid.replace(/:/g, "")}`;
  const describedBy = [error ? `${id}-err` : null, hint ? `${id}-hint` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && (
        <label htmlFor={id} className="text-sm font-semibold text-fg">
          {label}{required && <span aria-hidden className="ml-0.5 text-danger">*</span>}
        </label>
      )}
      {render({ id, "aria-invalid": error ? true : undefined, "aria-describedby": describedBy })}
      {hint && !error && <p id={`${id}-hint`} className="text-xs text-fg-subtle">{hint}</p>}
      {error && (
        <p id={`${id}-err`} role="alert" className="flex items-center gap-1 text-xs font-medium text-danger-fg">
          <AlertCircle className="size-3.5 shrink-0" aria-hidden />{error}
        </p>
      )}
    </div>
  );
}

export const controlClass =
  "w-full rounded-xl border border-border-strong bg-surface px-3.5 text-base text-fg shadow-[inset_0_1px_2px_rgb(60_35_15/0.04)] placeholder:text-fg-subtle transition-[border-color,box-shadow] duration-150 hover:border-fg-subtle/70 focus:border-ring focus:outline-none focus:ring-4 focus:ring-ring/15 disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-danger aria-[invalid=true]:focus:ring-danger/25 sm:text-sm";
