"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { LogOut } from "lucide-react";
import { Badge, Button, Notice, PageHeader, Section } from "@chilli/ui";
import { Card, Skeleton, toast } from "@/components/ui";
import { PasswordInput } from "@/components/auth/fields";
import { api, ApiError, auth } from "@/lib/api";
import { pwSchema } from "@/lib/passwords";
import { useSignOut } from "@/lib/useSignOut";
import { useMsg } from "@/lib/i18n";
import { AUTH_MSG } from "@/components/auth/messages";
import { fieldError } from "@/components/auth/validation";
import { ROLE_INFO_MSG } from "@/app/manage/_components/staff-messages";
import { ACCOUNT_MSG } from "./messages";
import type { Me } from "@/lib/types";
import { MyPinCard } from "@/components/devices/MyPinCard";
import { MyDevices } from "@/components/devices/MyDevices";

type Form = { current: string; next: string; again: string };

/** My account: who I am, my own password, counter PIN and signed-in devices. Any signed-in role. Changing the password signs out every device, this one included. */
export default function AccountPage() {
  const router = useRouter();
  const t = useMsg(ACCOUNT_MSG);
  const ta = useMsg(AUTH_MSG);
  const tr = useMsg(ROLE_INFO_MSG);
  const signOut = useSignOut();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<"offline" | "loadFail" | null>(null);
  const { register, handleSubmit, reset, setError: setFieldError, formState: { errors, isSubmitting } } = useForm<Form>({ resolver: zodResolver(pwSchema), defaultValues: { current: "", next: "", again: "" } });

  useEffect(() => {
    if (!auth.token) { router.replace("/login"); return; }
    api.me().then(setMe, (e) => setError(e instanceof ApiError && e.status === 0 ? "offline" : "loadFail"));
    }, [router]);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader title={t("title")} description={t("subtitle")} />
      {error && <Notice tone="warning">{t(error)}</Notice>}

      <Section title={t("profile")}>
        {!me && !error ? <div role="status" aria-label={t("loading")}><Skeleton className="h-20 rounded-xl" /></div> : me && (
          <Card className="flex flex-wrap items-center gap-3" data-testid="account-profile">
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold text-fg">{me.full_name}</p>
              <p className="truncate text-sm text-fg-muted">{me.email}</p>
            </div>
            <Badge tone="primary" className="capitalize">{ROLE_INFO_MSG[`${me.role}.label` as keyof typeof ROLE_INFO_MSG] ? tr(`${me.role}.label`) : me.role}</Badge>
          </Card>
        )}
      </Section>

      <Section title={t("changeTitle")} description={t("changeDesc")}>
        <form noValidate className="flex max-w-sm flex-col gap-4" onSubmit={handleSubmit(async (v) => {
          try { await api.changePassword(v.current, v.next); toast.success(t("changed")); reset(); await signOut(); }
          catch (e) { setFieldError("current", { message: e instanceof ApiError ? (e.status === 429 ? t("tooMany") : e.message) : t("changeFail") }); }
        })}>
          <PasswordInput label={t("current")} autoComplete="current-password" error={fieldError(ta, errors.current?.message)} {...register("current")} />
          <PasswordInput label={t("next")} autoComplete="new-password" error={fieldError(ta, errors.next?.message)} {...register("next")} />
          <PasswordInput label={t("again")} autoComplete="new-password" error={fieldError(ta, errors.again?.message)} {...register("again")} />
          <Button type="submit" variant="primary" loading={isSubmitting}>{t("changeBtn")}</Button>
        </form>
      </Section>

      <MyPinCard />

      {me && <MyDevices me={me} />}

      <Section title={t("signOutTitle")}>
        <Button variant="secondary" iconStart={<LogOut />} onClick={() => void signOut()}>{t("signOutBtn")}</Button>
      </Section>
    </div>
  );
}
