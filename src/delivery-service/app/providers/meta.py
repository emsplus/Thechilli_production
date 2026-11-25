"""Meta WhatsApp Cloud API adapter (httpx). Tested only against a fake transport: no credentials exist in this repo.

Sending: inside the 24 h customer-service window a free-text message is sent; outside it only an approved template can be
sent (registry: app/providers/templates.py, doc: docs/WHATSAPP_TEMPLATES.md). If Meta still answers 131047 ("re-engagement
message") to a free-text send (our window estimate was wrong), the same message is retried once as its template.
"""
import httpx

from app.core.config import settings
from app.providers import templates
from app.providers.base import (
    InboundMessageEvent,
    OutboundRequest,
    ProviderError,
    StatusEvent,
    WhatsAppProvider,
    normalize_number,
)

# Meta error code -> retryable? (docs: developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes)
_RETRYABLE_CODES = {1, 2, 4, 17, 32, 613, 80007, 130429, 131056, 131048, 133004, 133005}
_REENGAGEMENT = 131047


class MetaWhatsAppProvider(WhatsAppProvider):
    def __init__(self, access_token: str | None = None, default_phone_number_id: str | None = None,
                 transport: httpx.BaseTransport | None = None):
        self._token = access_token if access_token is not None else settings.whatsapp_access_token.get_secret_value()
        self._default_pnid = (default_phone_number_id if default_phone_number_id is not None
                              else settings.whatsapp_phone_number_id)
        self._transport = transport

    # ---------------------------------------------------------------- send
    def send(self, req: OutboundRequest) -> str:
        if not self._token:
            raise ProviderError("WHATSAPP_ACCESS_TOKEN is not set", retryable=False)
        pnid = req.phone_number_id or self._default_pnid
        if not pnid:
            raise ProviderError("no sender phone_number_id", retryable=False)
        to = normalize_number(req.to)
        if len(to) < 8:
            raise ProviderError("invalid recipient number", retryable=False)
        tpl = templates.REGISTRY.get(req.template)
        use_template = not req.in_window
        if use_template and (tpl is None or not tpl.registered):
            raise ProviderError(f"outside the 24h window and {req.template!r} has no approved template", retryable=False)
        try:
            return self._post(pnid, self._payload(to, req, tpl, use_template))
        except _Reengagement:
            if tpl is None or not tpl.registered or use_template:
                raise ProviderError("recipient is outside the 24h window and no template is available",
                                    retryable=False) from None
            return self._post(pnid, self._payload(to, req, tpl, True))

    @staticmethod
    def _payload(to: str, req: OutboundRequest, tpl: templates.Template | None, use_template: bool) -> dict:
        base = {"messaging_product": "whatsapp", "recipient_type": "individual", "to": to}
        if use_template:
            assert tpl is not None
            params = [{"type": "text", "text": templates.sanitize_param(v)} for v in tpl.ordered(req.params)]
            return {**base, "type": "template", "template": {
                "name": tpl.name, "language": {"code": tpl.language},
                "components": [{"type": "body", "parameters": params}] if params else []}}
        return {**base, "type": "text", "text": {"preview_url": False, "body": req.text}}

    def _post(self, phone_number_id: str, payload: dict) -> str:
        url = f"{settings.whatsapp_graph_base}/{settings.whatsapp_api_version}/{phone_number_id}/messages"
        try:
            with httpx.Client(timeout=settings.whatsapp_timeout_seconds, transport=self._transport) as c:
                r = c.post(url, json=payload, headers={"Authorization": f"Bearer {self._token}"})
        except httpx.HTTPError as e:
            raise ProviderError(f"network error: {type(e).__name__}", retryable=True) from e
        if r.status_code < 300:
            try:
                return str(r.json()["messages"][0]["id"])
            except (ValueError, KeyError, IndexError, TypeError):
                raise ProviderError("unexpected response from Meta", retryable=True) from None
        code, title = _error(r)
        if code == _REENGAGEMENT:
            raise _Reengagement
        # never log the token or the message body; the code and Meta's title are enough to debug
        retryable = r.status_code >= 500 or r.status_code == 429 or code in _RETRYABLE_CODES
        raise ProviderError(f"meta {r.status_code} code={code}: {title}"[:300], retryable=retryable)

    # ---------------------------------------------------------------- inbound
    def parse_webhook(self, payload: dict) -> list[InboundMessageEvent]:
        out = []
        for value in _values(payload):
            pnid = str(value.get("metadata", {}).get("phone_number_id", ""))
            for m in value.get("messages", []) or []:
                out.append(self._message(pnid, m))
        return out

    @staticmethod
    def _message(pnid: str, m: dict) -> InboundMessageEvent:
        kind_raw = m.get("type", "text")
        ev = InboundMessageEvent(pnid, str(m.get("id", "")), str(m.get("from", "")), "")
        if kind_raw == "text":
            ev.text = str(m.get("text", {}).get("body", ""))
        elif kind_raw == "location":
            loc = m.get("location", {})
            ev.kind, ev.lat, ev.lng = "location", _f(loc.get("latitude")), _f(loc.get("longitude"))
            ev.place_name = " ".join(str(x) for x in (loc.get("name"), loc.get("address")) if x)
        elif kind_raw in ("audio", "voice"):
            ev.kind, ev.media_id = "audio", str(m.get("audio", {}).get("id", "")) or None
        elif kind_raw == "image":
            ev.kind, ev.media_id = "image", str(m.get("image", {}).get("id", "")) or None
            ev.text = str(m.get("image", {}).get("caption", ""))
        elif kind_raw == "button":
            ev.kind, ev.text = "button", str(m.get("button", {}).get("payload") or m.get("button", {}).get("text", ""))
        elif kind_raw == "interactive":
            it = m.get("interactive", {})
            reply = it.get("button_reply") or it.get("list_reply") or {}
            ev.kind, ev.text = "button", str(reply.get("id") or reply.get("title", ""))
        else:
            ev.kind = "other"
        return ev

    def parse_statuses(self, payload: dict) -> list[StatusEvent]:
        out = []
        for value in _values(payload):
            pnid = str(value.get("metadata", {}).get("phone_number_id", ""))
            for s in value.get("statuses", []) or []:
                status = str(s.get("status", ""))
                if status not in ("sent", "delivered", "read", "failed"):
                    continue
                err = (s.get("errors") or [{}])[0]
                ts = s.get("timestamp")
                out.append(StatusEvent(pnid, str(s.get("id", "")), status, str(s.get("recipient_id", "")),
                                       int(ts) if str(ts).isdigit() else None,
                                       str(err["code"]) if "code" in err else None,
                                       str(err.get("title") or err.get("message") or "")[:200] or None))
        return out


class _Reengagement(Exception):
    pass


def _values(payload: dict):
    entries = payload.get("entry") if isinstance(payload, dict) else None
    for entry in entries if isinstance(entries, list) else []:
        changes = entry.get("changes") if isinstance(entry, dict) else None
        for change in changes if isinstance(changes, list) else []:
            if isinstance(change, dict) and isinstance(change.get("value"), dict):
                yield change["value"]


def _f(v) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _error(r: httpx.Response) -> tuple[int | None, str]:
    try:
        e = r.json().get("error", {})
        return (int(e["code"]) if "code" in e else None), str(e.get("error_data", {}).get("details") or e.get("message", ""))
    except (ValueError, AttributeError, TypeError):
        return None, ""
