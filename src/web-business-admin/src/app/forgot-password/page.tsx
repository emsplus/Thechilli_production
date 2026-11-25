import Link from "next/link";
import { AuthShell } from "@/components/auth/AuthShell";
import { BackToLoginText, ForgotPageIntro, ForgotPasswordForm, ResetGuidance } from "@/components/auth/ForgotPasswordDialog";

export const metadata = { title: "Forgot password" };

export default function ForgotPasswordPage() {
  return (
    <AuthShell>
      <div className="mx-auto w-full max-w-sm space-y-5">
        <ForgotPageIntro />
        <ForgotPasswordForm />
        <ResetGuidance />
        <p className="text-center text-sm"><Link href="/login" className="font-semibold text-primary-soft-fg underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"><BackToLoginText /></Link></p>
      </div>
    </AuthShell>
  );
}
