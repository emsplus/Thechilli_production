"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { AuthShell } from "@/components/auth/AuthShell";
import { PasswordInput } from "@/components/auth/fields";
import { Button, Notice } from "@chilli/ui";
import { api, ApiError } from "@/lib/api";
import { useMsg } from "@/lib/i18n";
import { AUTH_MSG } from "@/components/auth/messages";
import { fieldError } from "@/components/auth/validation";
import { preferredLocale, readResetLink, resetSchema, resetUnsupported } from "@/lib/passwords";

type Link_ = { restaurantId: string | null; token: string | null } | "pending";
type Status = "idle" | "done" | "invalid" | "unsupported";

/** Target of the emailed link: `/reset-password?r=<restaurant id>#t=<token>`. The token lives in the fragment, which is read once and then removed from the address bar. */
export default function ResetPasswordPage() {
  const t = useMsg(AUTH_MSG);
  const [link, setLink] = useState<Link_>("pending");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<{ next: string; again: string }>({ resolver: zodResolver(resetSchema), defaultValues: { next: "", again: "" } });

  useEffect(() => {
    const l = readResetLink(window.location.search, window.location.hash);
    try { if (l.token) window.history.replaceState(null, "", window.location.pathname + window.location.search); } catch { /* ignore */ }
    void Promise.resolve().then(() => setLink(l));
  }, []);

  const missing = link !== "pending" && (!link.restaurantId || !link.token);

  return (
    <AuthShell>
      <div className="mx-auto w-full max-w-sm">
        <h1 className="font-display text-3xl font-extrabold tracking-tight text-fg">{t("setNewTitle")}</h1>
        {status === "done" ? (
          <div className="mt-6 space-y-4" data-testid="reset-done">
            <Notice tone="success">{t("resetDone")}</Notice>
            <Link href="/login" className="inline-flex min-h-11 items-center font-semibold text-primary-soft-fg underline-offset-4 hover:underline">{t("goToLogin")}</Link>
          </div>
        ) : missing || status === "invalid" || status === "unsupported" ? (
          <div className="mt-6 space-y-4" data-testid="reset-invalid">
            <Notice tone="danger">{status === "unsupported" ? t("resetOff") : t("linkInvalid")}</Notice>
            <Link href="/forgot-password" className="inline-flex min-h-11 items-center font-semibold text-primary-soft-fg underline-offset-4 hover:underline">{t("newLink")}</Link>
          </div>
        ) : (
          <>
            <p className="mt-2 text-sm text-fg-muted">{t("chooseDesc")}</p>
            {error && <div className="mt-6"><Notice tone="danger">{error}</Notice></div>}
            <form noValidate className="mt-6 flex flex-col gap-5" onSubmit={handleSubmit(async (v) => {
              if (link === "pending" || !link.restaurantId || !link.token) return;
              setError(null);
              try { await api.resetPassword({ restaurant_id: link.restaurantId, token: link.token, new_password: v.next, locale: preferredLocale() }); setStatus("done"); }
              catch (e) {
                if (resetUnsupported(e)) setStatus("unsupported");
                else if (e instanceof ApiError && e.status === 400) setStatus("invalid");
                else if (e instanceof ApiError && e.status === 429) setError(t("resetTooMany"));
                else if (e instanceof ApiError && e.status === 0) setError(t("offline"));
                else setError(e instanceof ApiError && e.status === 422 ? t("pwNotAllowed") : t("pwChangeFail"));
              }
            })}>
              <PasswordInput label={t("newPassword")} autoComplete="new-password" error={fieldError(t, errors.next?.message)} {...register("next")} />
              <PasswordInput label={t("newPasswordAgain")} autoComplete="new-password" error={fieldError(t, errors.again?.message)} {...register("again")} />
              <Button type="submit" variant="primary" size="lg" loading={isSubmitting || link === "pending"} className="w-full">{t("changePassword")}</Button>
            </form>
          </>
        )}
      </div>
    </AuthShell>
  );
}
