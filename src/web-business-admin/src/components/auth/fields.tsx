"use client";

import { useId, useState, type ComponentProps } from "react";
import { Eye, EyeOff, Lock } from "lucide-react";
import { cn } from "@/lib/cn";
import { useMsg } from "@/lib/i18n";
import { AUTH_MSG } from "./messages";
import { controlClass, FieldShell, type FieldProps } from "@/components/ui/field";

type PasswordProps = Omit<ComponentProps<"input">, "type" | "size"> & FieldProps;

/** Password input with a leading lock and a show / hide toggle. Works with react-hook-form's register().
 * `variant="pill"`: the design-system pill field used inside AuthSplit (/login, /register). */
export function PasswordInput({ variant, ...rest }: PasswordProps & { variant?: "default" | "pill" }) {
  return variant === "pill" ? <PillPassword {...rest} /> : <BoxPassword {...rest} />;
}

function EyeToggle({ shown, onToggle, className }: { shown: boolean; onToggle: () => void; className: string }) {
  const t = useMsg(AUTH_MSG);
  return (
    <button type="button" onClick={onToggle} aria-label={shown ? t("hideChars") : t("showChars")} aria-pressed={shown} className={className}>
      {shown ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
    </button>
  );
}

/** Same markup and classes as @chilli/ui PasswordInput variant="pill" (leading lock, ch-input-wrap), with the app's eye toggle. */
function PillPassword({ label, hint, error, className, id, ...props }: PasswordProps) {
  const [shown, setShown] = useState(false);
  const auto = useId();
  const fid = id ?? `pw${auto.replace(/:/g, "")}`;
  const described = error ? `${fid}-err` : hint ? `${fid}-hint` : undefined;
  return (
    <div className="ch-field">
      {label && <label className="ch-label" htmlFor={fid}>{label}</label>}
      <div className="ch-input-wrap">
        <span className="ch-input-wrap__icon" aria-hidden="true"><Lock /></span>
        <input {...props} id={fid} type={shown ? "text" : "password"} aria-invalid={error ? true : undefined} aria-describedby={described}
          className={cn("ch-input ch-input--pill ch-input--icon ch-input--end", className)} />
        <EyeToggle shown={shown} onToggle={() => setShown((v) => !v)}
          className="absolute inset-y-0 right-1.5 my-auto grid size-11 place-items-center rounded-full text-fg-subtle transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring [&_svg]:size-[1.1rem]" />
      </div>
      {hint && !error ? <p className="ch-hint" id={`${fid}-hint`}>{hint}</p> : null}
      {error ? <p className="ch-error" id={`${fid}-err`} role="alert">{error}</p> : null}
    </div>
  );
}

function BoxPassword({ label, hint, error, className, ...props }: PasswordProps) {
  const [shown, setShown] = useState(false);
  return (
    <FieldShell label={label} hint={hint} error={error}
      render={(a) => (
        <div className="relative">
          <span className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-fg-subtle [&_svg]:size-[1.05rem]"><Lock aria-hidden /></span>
          <input {...a} {...props} type={shown ? "text" : "password"} className={cn(controlClass, "h-12 pl-10 pr-12", className)} />
          <EyeToggle shown={shown} onToggle={() => setShown((v) => !v)}
            className="absolute inset-y-0 right-0.5 my-auto grid size-11 place-items-center rounded-lg text-fg-subtle transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring [&_svg]:size-[1.1rem]" />
        </div>
      )} />
  );
}
