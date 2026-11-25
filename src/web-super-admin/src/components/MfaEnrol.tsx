"use client";
import { useState, type FormEvent } from "react";
import { Button, Input } from "@chilli/ui";
import { ApiError } from "@/lib/api";
import type { MfaEnrolDone, MfaEnrolStart } from "@/lib/api/types";
import { useAction } from "@/lib/useResource";
import { InlineError, Notice } from "@/components/ui";

const groups = (s: string) => s.replace(/(.{4})/g, "$1 ").trim();
const svgSrc = (svg: string) => `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;

/** Authenticator enrolment: secret + QR, confirm with a code, then show recovery codes once. Used at sign-in and on the security page. */
export function MfaEnrol({ start, confirm, onFinished, finishLabel = "Done" }: {
  start: () => Promise<MfaEnrolStart>;
  confirm: (code: string) => Promise<MfaEnrolDone>;
  onFinished: (done: MfaEnrolDone) => void;
  finishLabel?: string;
}) {
  const [info, setInfo] = useState<MfaEnrolStart>();
  const [done, setDone] = useState<MfaEnrolDone>();
  const [code, setCode] = useState("");
  const [saved, setSaved] = useState(false);
  const begin = useAction(async () => { setInfo(await start()); });
  const confirmA = useAction(async () => { setDone(await confirm(code.trim())); });
  const submit = (e: FormEvent) => { e.preventDefault(); if (code.trim()) void confirmA.run(); };

  if (done) {
    const text = done.recovery_codes.join("\n");
    return (
      <div className="hq-stack">
        <Notice tone="warning" title="Save your recovery codes now.">Each works once if you lose your authenticator. They are shown only this time.</Notice>
        <ul className="hq-codes" aria-label="Recovery codes">{done.recovery_codes.map((c) => <li key={c} className="hq-mono">{c}</li>)}</ul>
        <div className="hq-row">
          <Button onClick={() => void navigator.clipboard?.writeText(text)}>Copy</Button>
          <a className="hq-link" download="chilli-hq-recovery-codes.txt" href={`data:text/plain;charset=utf-8,${encodeURIComponent(text + "\n")}`}>Download .txt</a>
        </div>
        <label className="hq-check"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I have stored these codes somewhere safe</label>
        <div><Button variant="primary" disabled={!saved} onClick={() => onFinished(done)}>{finishLabel}</Button></div>
      </div>
    );
  }
  if (!info) {
    return (
      <div className="hq-stack">
        <p className="hq-sub">Use an authenticator app (Google Authenticator, Authy, 1Password...). You will scan a code, then confirm with the 6-digit number it shows.</p>
        <InlineError error={begin.error} />
        <div><Button variant="primary" loading={begin.busy} onClick={() => void begin.run()}>Set up authenticator</Button></div>
      </div>
    );
  }
  // data: URI in an <img>: scripts inside an SVG never run there, and next/image cannot optimise it anyway
  /* eslint-disable @next/next/no-img-element */
  const qr = info.qr_svg ? <img src={svgSrc(info.qr_svg)} width={176} height={176} alt={`QR code to add ${info.account} to your authenticator app`} /> : <p className="hq-muted">QR not available here. Enter the key manually.</p>;
  /* eslint-enable @next/next/no-img-element */
  return (
    <form className="hq-stack" onSubmit={submit} noValidate>
      <div className="hq-qr">
        {qr}
        <div>
          <p className="hq-sub">Cannot scan? Enter this key (time-based, 6 digits):</p>
          <p className="hq-mono" aria-label="Setup key">{groups(info.secret)}</p>
          <a className="hq-link" href={info.otpauth_uri}>Open in authenticator app</a>
        </div>
      </div>
      <Input label="6-digit code" inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={code} onChange={(e) => setCode(e.target.value)} hint="From your authenticator app, to confirm it works." />
      <InlineError error={confirmA.error instanceof ApiError ? confirmA.error : undefined} />
      <div><Button type="submit" variant="primary" loading={confirmA.busy}>Confirm and turn on</Button></div>
    </form>
  );
}
