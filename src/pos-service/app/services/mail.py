"""Mail provider interface: the one place that sends an email (docs/COMMS.md, docs/EMAIL.md).

Providers: RoutingProvider (applies MAIL_POLICY per recipient: real SMTP, the local mail catcher or a log line),
SmtpProvider (SMTP_* environment, SSL on 465 or STARTTLS on 587, certificate verification always on, connect/read timeout),
FileSinkProvider (writes `<id>.json` into a folder: EMAIL_SINK_DIR, or `MAIL_DEV_DIR` as the ENV=development default) and
FakeMailProvider (tests). `send` raises on failure; callers decide what a failure means (the re-order flow records it, the
password flow logs it and still answers the same way).

Mail policy (MAIL_POLICY, default real in production and allowlist elsewhere): `allowlist` really sends only to addresses in a
MAIL_ALLOWLIST_DOMAINS domain or exactly SMTP_TEST_TO; every other recipient is delivered to the catcher (MAILPIT_SMTP_HOST),
so demo and e2e users (owner@example.com) never cause real mail. Logs show recipients partly redacted (`o***@example.com`).

Secrets: the SMTP password only lives in `settings.smtp_password` (a SecretStr), is read in SmtpProvider.send and nowhere
else; `safe_error` strips it from any text that is logged or stored."""
import json
import logging
import os
import re
import smtplib
import ssl
import uuid
from email.message import EmailMessage
from email.utils import formataddr, make_msgid, parseaddr
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from typing import Protocol

from app.core.config import settings

log = logging.getLogger("app.mail")

_CTRL = re.compile(r"[\x00-\x1f\x7f\u2028\u2029]+")
EMAIL_RE = re.compile(r"^[^@\s<>,;\"']+@[^@\s<>,;\"']+\.[^@\s<>,;\"']+$")
POLICIES = ("real", "allowlist", "log", "mailpit")


def clean(v: str | None, limit: int = 300) -> str:
    """One line, no CR/LF or other control characters (header injection safe), trimmed."""
    return " ".join(_CTRL.sub(" ", v or "").split())[:limit]


def valid_email(v: str) -> bool:
    return bool(v) and len(v) <= 254 and not _CTRL.search(v) and bool(EMAIL_RE.match(v))


def from_address() -> str:
    return parseaddr(clean(settings.smtp_from or settings.smtp_user))[1]


def safe_error(e: Exception) -> str:
    return f"{type(e).__name__}: {e}"[:300].replace(settings.smtp_password.get_secret_value() or "\0", "***")


def redact(address: str | None) -> str:
    """`owner@example.com` -> `o***@example.com`: enough to tell recipients apart in a log, not the address itself."""
    local, _, domain = (address or "").strip().rpartition("@")
    if not local:
        return "***"
    return f"{local[0]}***@{domain}"


# ---------------------------------------------------------------- policy
def policy() -> str:
    p = (settings.mail_policy or "").strip().lower()
    if p in POLICIES:
        return p
    return "real" if settings.env == "production" else "allowlist"


def allowlisted(address: str) -> bool:
    """Under the allowlist policy: may this recipient get REAL mail? Its domain is in MAIL_ALLOWLIST_DOMAINS or it is exactly
    SMTP_TEST_TO (case-insensitive). Sub-domains do not match."""
    a = (address or "").strip().lower()
    if not valid_email(a):
        return False
    test_to = (settings.smtp_test_to or "").strip().lower()
    if test_to and a == test_to:
        return True
    domains = {d.strip().lower().lstrip("@") for d in (settings.mail_allowlist_domains or "").split(",") if d.strip()}
    return a.rpartition("@")[2] in domains


def smtp_configured() -> bool:
    return bool(settings.smtp_host.strip() and from_address())


def mailpit_configured() -> bool:
    return bool(settings.mailpit_smtp_host.strip())


def route(address: str) -> str:
    """smtp | mailpit | log | devdir | none: where a message to `address` goes under the current policy."""
    pol = policy()
    fallback = "devdir" if settings.env == "development" and settings.mail_dev_dir.strip() else "none"
    if pol == "log":
        return "log"
    if pol == "real":
        return "smtp" if smtp_configured() else fallback
    if pol == "allowlist" and smtp_configured() and allowlisted(address):
        return "smtp"
    return "mailpit" if mailpit_configured() else fallback  # allowlist (not allowed) / mailpit


class MailProvider(Protocol):
    def send(self, msg: EmailMessage) -> None: ...


class SmtpProvider:
    """One SMTP submission. Defaults to SMTP_*; the mail catcher uses plain SMTP without login (host/port/security given).
    SMTP_SECURITY: ssl = implicit TLS (465), starttls = upgrade after EHLO (587), none = plain (local catcher only)."""

    def __init__(self, host: str | None = None, port: int | None = None, security: str | None = None, login: bool = True):
        self.host = (host if host is not None else settings.smtp_host).strip()
        self.port = port if port is not None else settings.smtp_port
        self.security = security if security is not None else settings.smtp_security
        self.login = login

    def send(self, msg: EmailMessage) -> None:
        host, port, mode = self.host, self.port, self.security
        if "PYTEST_CURRENT_TEST" in os.environ and host not in ("127.0.0.1", "localhost"):
            raise RuntimeError("Refusing to contact a real mail server from a test")
        ctx = ssl.create_default_context()  # certificate + hostname verification stay ON
        cls = smtplib.SMTP_SSL if mode == "ssl" else smtplib.SMTP
        kw: dict = {"timeout": settings.smtp_timeout}
        if mode == "ssl":
            kw["context"] = ctx
        with cls(host, port, **kw) as s:
            if mode == "starttls":
                s.starttls(context=ctx)  # EHLO before and after is done by smtplib itself
            user = settings.smtp_user.strip()
            if self.login and user:
                s.login(user, settings.smtp_password.get_secret_value())
            s.send_message(msg, from_addr=from_address() or "noreply@localhost", to_addrs=[msg["To"]])


class RoutingProvider:
    """Applies MAIL_POLICY to every message (one recipient each, see build())."""

    def send(self, msg: EmailMessage) -> None:
        to = msg["To"] or ""
        where = route(to)
        if where == "smtp":
            SmtpProvider().send(msg)
        elif where == "mailpit":
            if policy() != "mailpit":
                msg["X-Chilli-Diverted"] = f"MAIL_POLICY={policy()}: recipient not allowlisted"
            SmtpProvider(settings.mailpit_smtp_host, settings.mailpit_smtp_port, "none", login=False).send(msg)
        elif where == "devdir":
            FileSinkProvider(settings.mail_dev_dir.strip()).send(msg)
        elif where == "log":
            if settings.env == "development" and settings.mail_dev_dir.strip():
                FileSinkProvider(settings.mail_dev_dir.strip()).send(msg)
        else:
            raise RuntimeError("Email is not set up")
        log.info("mail %s via %s to %s", msg["Message-ID"] or "-", where, redact(to))


class FileSinkProvider:
    def __init__(self, directory: str):
        self.directory = directory

    def send(self, msg: EmailMessage) -> None:
        d = Path(self.directory)
        d.mkdir(parents=True, exist_ok=True)
        plain, html = msg.get_body(("plain",)), msg.get_body(("html",))
        (d / f"{uuid.uuid4()}.json").write_text(json.dumps({
            "to": msg["To"], "subject": msg["Subject"], "text": plain.get_content() if plain else "",
            "html": html.get_content() if html else ""}))


class FakeMailProvider:
    """Records every message; `fail` (an exception) makes every send raise; `delay` simulates a slow server."""

    def __init__(self):
        self.messages: list[EmailMessage] = []
        self.fail: Exception | None = None
        self.delay = 0.0

    def send(self, msg: EmailMessage) -> None:
        if self.delay:
            import time
            time.sleep(self.delay)
        if self.fail:
            raise self.fail
        self.messages.append(msg)

    def to(self, address: str) -> list[EmailMessage]:
        return [m for m in self.messages if m["To"] == address]


_override: MailProvider | None = None


def set_provider(p: MailProvider | None) -> None:
    """Tests install a Fake here (and None to remove it)."""
    global _override
    _override = p


def configured() -> bool:
    """True when mail is explicitly set up: an SMTP host + sender mailbox, the mail catcher under a non-real policy, or a
    sink folder."""
    return bool(settings.email_sink_dir.strip() or smtp_configured() or (policy() != "real" and mailpit_configured()))


def sender_problem() -> str | None:
    """SMTP_HOST (or the mail catcher) is set up but there is no sender address (SMTP_FROM, else SMTP_USER): every message that
    would really go out fails. None when fine or when mail is not set up at all (that is a legitimate state)."""
    if from_address() or not (settings.smtp_host.strip() or settings.mailpit_smtp_host.strip()):
        return None
    return ("SMTP_FROM is not set (and SMTP_USER is empty) although SMTP_HOST / the mail catcher is configured: no email can be sent "
            "(owner invites, receipts, reports). Set SMTP_FROM, e.g. SMTP_FROM=Chilli Agent <no-reply@zonov.ai> (compose/.env.secrets)")


def check_config() -> None:
    """Startup check: a loud error in the log (not a crash: the POS keeps working without mail)."""
    problem = sender_problem()
    if problem:
        log.error("MAIL NOT CONFIGURED: %s", problem)


def get_provider() -> MailProvider | None:
    if _override is not None:
        return _override
    if settings.email_sink_dir.strip():
        return FileSinkProvider(settings.email_sink_dir.strip())
    if configured() or policy() == "log":
        return RoutingProvider()
    if settings.env == "development" and settings.mail_dev_dir.strip():
        return FileSinkProvider(settings.mail_dev_dir.strip())  # development default; never in production
    return None


def send(msg: EmailMessage) -> None:
    p = get_provider()
    if p is None:
        raise RuntimeError("Email is not set up")
    p.send(msg)


def build(to: str, subject: str, text: str, html: str | None = None, from_name: str | None = None,
          attachments: list[tuple[str, str, bytes]] | None = None) -> EmailMessage:
    """One message to ONE recipient. attachments: (filename, mime type, bytes)."""
    sender = from_address() or "noreply@localhost"
    to = clean(to, 254)
    if not valid_email(to):
        raise ValueError("The recipient's email address is not valid")
    msg = EmailMessage()
    msg["From"] = formataddr((clean(from_name, 120), sender)) if from_name else sender
    msg["To"] = to
    msg["Subject"] = clean(subject)
    msg["Message-ID"] = make_msgid(domain=sender.rpartition("@")[2] or "localhost")
    msg.set_content(text)
    if html:
        msg.add_alternative(html, subtype="html")
    for name, mime, data in attachments or ():
        maintype, _, subtype = mime.partition("/")
        msg.add_attachment(data, maintype=maintype, subtype=subtype, filename=clean(name, 120))
    return msg


# ---------------------------------------------------------------- background sending
_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="mail")


def _safe(fn, *args) -> None:
    try:
        fn(*args)
    except Exception as e:  # noqa: BLE001 - a mail problem never reaches the request that triggered it
        log.warning("background mail job failed: %s", safe_error(e))


def submit(fn, *args) -> None:
    """Runs fn(*args) off the request thread (so the response time never depends on the mail server). Tests replace this
    to run the job inline."""
    _pool.submit(_safe, fn, *args)
