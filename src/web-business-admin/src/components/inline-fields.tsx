"use client";

import { forwardRef, type ComponentProps, type ReactNode } from "react";
import { Input, Select, Textarea } from "@chilli/ui";
import { cn } from "@/lib/cn";

/**
 * Compact fields for table cells and toolbars: the design-system fields (which always carry a label), with the
 * label kept for assistive tech and hidden visually (`.ch-inline` in globals.css). Use the plain design-system
 * fields wherever a visible label fits.
 */
type Base = { "aria-label": string; wrapperClassName?: string; leading?: ReactNode };

export const InlineInput = forwardRef<HTMLInputElement, Omit<ComponentProps<typeof Input>, "label" | "aria-label"> & Base>(
  function InlineInput({ "aria-label": label, wrapperClassName, leading, ...rest }, ref) {
    void leading;
    return <div className={cn("ch-inline", wrapperClassName)}><Input ref={ref} label={label} {...rest} /></div>;
  });

export const InlineSelect = forwardRef<HTMLSelectElement, Omit<ComponentProps<typeof Select>, "label" | "aria-label"> & Base>(
  function InlineSelect({ "aria-label": label, wrapperClassName, leading, ...rest }, ref) {
    void leading;
    return <div className={cn("ch-inline", wrapperClassName)}><Select ref={ref} label={label} {...rest} /></div>;
  });

export const InlineTextarea = forwardRef<HTMLTextAreaElement, Omit<ComponentProps<typeof Textarea>, "label" | "aria-label"> & Base>(
  function InlineTextarea({ "aria-label": label, wrapperClassName, leading, ...rest }, ref) {
    void leading;
    return <div className={cn("ch-inline", wrapperClassName)}><Textarea ref={ref} label={label} {...rest} /></div>;
  });
