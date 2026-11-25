"use client";
import Link from "next/link";
import { Card, PageHeader, Section } from "@chilli/ui";
import { useAuth } from "@/components/auth";
import { ROLE_LABEL, can } from "@/lib/roles";
import { MOCK_MODE } from "@/lib/api";

interface Topic { q: string; a: string; show?: boolean }

export default function SupportPage() {
  const { user } = useAuth();
  const role = user?.role;
  const topics: Topic[] = [
    { q: "How do I add a lead?", a: "Open Leads, then + Lead. Name, contact and phone are enough. We check for a duplicate as you type; if someone already owns it, ask your marketing admin to assign or merge it.", show: can(role, "lead.write") },
    { q: "Why can I not see a lead or application?", a: "You only see rows you own or created (salespeople) or applications assigned to you (onboarding agents). A row you cannot see is reported as not found. Ask your marketing admin to assign it to you.", show: role !== "marketing_admin" },
    { q: "How do I start onboarding a business?", a: "Open Onboarding, then New application. Link a lead or type the business name, work through the five checklist steps, and provision once everything is ready.", show: can(role, "onboarding.create") },
    { q: "An invite code was lost or the email did not arrive.", a: "Open Onboarding, then Invitations, and resend it. The code is shown only once, so copy it straight away. Never paste an invite code into chat groups." },
    { q: "When do I get commission?", a: "A pending entry is created when a business you brought in is provisioned. A marketing admin approves it, then marks it paid. Admins cannot approve their own entries. See Earnings for the status of each entry, and Reports for earned versus paid." },
    { q: "How do I export numbers?", a: "Reports has a table per topic with an Export CSV button. Pick the period first; the file contains exactly what the table shows." },
    { q: "How do I approve commissions or manage the team?", a: "Earnings holds the ledger and rules, Team holds users, performance and the audit log. These are for marketing admins.", show: can(role, "commission.decide") },
    { q: "I cannot sign in or I was signed out.", a: "Sessions expire for safety; sign in again and you return to the page you were on. If your password is rejected, ask your marketing admin to reset it, then change it under Account." },
  ];
  return (
    <div className="stack">
      <PageHeader title="Support" description={role ? `Help for ${ROLE_LABEL[role]}s. Your marketing admin is the first contact for anything below.` : undefined} />
      <Section title="Common questions">
        <div className="stack-sm">
          {topics.filter((t) => t.show !== false).map((t) => (
            <Card key={t.q} as="section">
              <details>
                <summary style={{ minHeight: 44, display: "flex", alignItems: "center", cursor: "pointer", fontWeight: 600 }}>{t.q}</summary>
                <p style={{ paddingBottom: 8 }}>{t.a}</p>
              </details>
            </Card>
          ))}
        </div>
      </Section>
      <Section title="Report a problem">
        <Card as="div">
          <p>Tell your marketing admin: the page address, roughly what time it happened, what you pressed and what you expected. Do not send customer phone numbers or documents in chat; the lead or application link is enough, because admins can open it and read the audit log.</p>
          <p className="muted small" style={{ marginTop: 8 }}>
            Signed in as {user?.name} ({user?.email}){MOCK_MODE ? ", demo data mode" : ""}. <Link href="/account">Change your password</Link>.
          </p>
        </Card>
      </Section>
    </div>
  );
}
