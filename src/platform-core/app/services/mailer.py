"""Outbound email behind a tiny interface. platform-core is independent of every other service's mailer.

`Mailer.send` raises MailError on any failure; callers treat that as retryable. FakeMailer keeps messages in memory (tests);
SmtpMailer reads SMTP_* from the environment (config.Settings). Message bodies can carry secrets (an owner invite link):
neither implementation logs them, only recipient domain and outcome."""
import logging
import smtplib
import ssl
from dataclasses import dataclass, field
from email.message import EmailMessage
from typing import Protocol

from app.core.config import settings

log = logging.getLogger("app.mailer")


class MailError(Exception):
    pass


class Mailer(Protocol):
    def send(self, to: str, subject: str, text: str, html: str | None = None) -> None: ...


@dataclass
class SentMail:
    to: str
    subject: str
    text: str
    html: str | None = field(default=None, repr=False)


class FakeMailer:
    def __init__(self, fail: bool = False):
        self.outbox: list[SentMail] = []
        self.fail = fail

    def send(self, to: str, subject: str, text: str, html: str | None = None) -> None:
        if self.fail:
            raise MailError("fake mailer: simulated failure")
        self.outbox.append(SentMail(to, subject, text, html))


def redact(address: str | None) -> str:
    """`owner@example.com` -> `o***@example.com` (logs never carry full recipient addresses)."""
    local, _, domain = (address or "").strip().rpartition("@")
    return f"{local[0]}***@{domain}" if local else "***"


def policy() -> str:
    p = (settings.mail_policy or "").strip().lower()
    if p in ("real", "allowlist", "log", "mailpit"):
        return p
    return "real" if settings.env == "production" else "allowlist"


def allowlisted(address: str) -> bool:
    a = (address or "").strip().lower()
    if "@" not in a:
        return False
    if settings.smtp_test_to.strip() and a == settings.smtp_test_to.strip().lower():
        return True
    domains = {d.strip().lower().lstrip("@") for d in settings.mail_allowlist_domains.split(",") if d.strip()}
    return a.rpartition("@")[2] in domains


def route(address: str) -> str:
    """smtp | mailpit | log: where a message to `address` goes under MAIL_POLICY."""
    pol = policy()
    if pol == "real" or (pol == "allowlist" and allowlisted(address)):
        return "smtp"
    if pol in ("allowlist", "mailpit") and settings.mailpit_smtp_host.strip():
        return "mailpit"
    return "log"


class SmtpMailer:
    """SMTP_HOST, SMTP_PORT (465), SMTP_SECURITY (ssl|starttls|none), SMTP_USER, SMTP_PASSWORD, SMTP_FROM (default SMTP_USER),
    SMTP_TIMEOUT, with MAIL_POLICY applied per recipient (real / allowlist / mailpit / log, see config). Without SMTP_HOST a
    message that should really go out raises MailError (so the provisioning step stays retryable)."""

    def send(self, to: str, subject: str, text: str, html: str | None = None) -> None:
        s = settings
        where = route(to)
        if where == "log":
            log.warning("mail NOT sent (MAIL_POLICY=%s) to %s", policy(), redact(to))
            return
        host, port, mode, login = s.smtp_host, s.smtp_port, s.smtp_security, True
        if where == "mailpit":
            host, port, mode, login = s.mailpit_smtp_host.strip(), s.mailpit_smtp_port, "none", False
        if not host:
            raise MailError("SMTP is not configured (SMTP_HOST is empty)")
        sender = s.smtp_from or s.smtp_user
        if not sender:
            raise MailError("SMTP_FROM is not configured")
        msg = EmailMessage()
        msg["From"], msg["To"], msg["Subject"] = sender, to, subject
        if where == "mailpit" and policy() != "mailpit":
            msg["X-Chilli-Diverted"] = f"MAIL_POLICY={policy()}: recipient not allowlisted"
        msg.set_content(text)
        if html:
            msg.add_alternative(html, subtype="html")
        try:
            if mode == "ssl":
                conn = smtplib.SMTP_SSL(host, port, timeout=s.smtp_timeout, context=ssl.create_default_context())
            else:
                conn = smtplib.SMTP(host, port, timeout=s.smtp_timeout)
            with conn:
                if mode == "starttls":
                    conn.starttls(context=ssl.create_default_context())
                if login and s.smtp_user:
                    conn.login(s.smtp_user, s.smtp_password.get_secret_value())
                conn.send_message(msg)
        except (OSError, smtplib.SMTPException) as e:
            raise MailError(f"SMTP delivery failed: {type(e).__name__}") from None  # never the message / credentials
        log.info("mail sent via %s to %s", where, redact(to))


SENDER_HELP = ("set SMTP_FROM to the company sender, e.g. SMTP_FROM=Chilli Agent <no-reply@zonov.ai> "
               "(compose: compose/.env.secrets; see infra docs/DEPLOYMENT.md)")


def sender_problem() -> str | None:
    """A message when mail would be sent but there is no sender address (SMTP_FROM, else SMTP_USER); None when fine.
    Without it every owner invite fails with 'SMTP_FROM is not configured' and Provision ends in `failed`."""
    if settings.mailer != "smtp" or policy() == "log" or (settings.smtp_from or settings.smtp_user).strip():
        return None
    return f"SMTP_FROM is not set (and SMTP_USER is empty): owner invite emails will fail and provisioning ends in 'failed'; {SENDER_HELP}"


def check_config() -> None:
    """Startup check. Production refuses to start without a sender; elsewhere (local compose without .env.secrets) it logs a loud
    error on every start instead, so the cause is visible before the first Provision fails."""
    problem = sender_problem()
    if not problem:
        return
    if settings.is_production:
        raise RuntimeError("Refusing to start: " + problem)
    log.error("MAIL NOT CONFIGURED: %s", problem)


_override: Mailer | None = None


def set_mailer(m: Mailer | None) -> None:
    global _override
    _override = m


def get_mailer() -> Mailer:
    if _override is not None:
        return _override
    if settings.mailer == "fake":
        set_mailer(FakeMailer())
        return _override
    return SmtpMailer()
