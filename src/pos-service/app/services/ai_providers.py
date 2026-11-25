"""Which AI provider does what, and the one HTTP helper for the OpenAI-compatible ones (xAI Grok, OpenAI Whisper).

- OCR (invoice / bill scan):   AI_OCR_PROVIDER  gemini | xai | auto   (auto = xai when its key is set, else gemini)
- Speech to text (audio):      AI_STT_PROVIDER  gemini | whisper | auto (auto = whisper when its key is set, else gemini)
- Text LLM (voice fallback, recipes): AI_TEXT_PROVIDER gemini | xai | auto (auto = gemini)

Rules enforced here, not left to callers:
- keys come from the environment only (settings) and are sent only in the Authorization header. They are never logged,
  never put in an error, a status answer or a stored row. Provider failures are logged by exception TYPE only;
- the real network is never reached from a test run unless the test installs a fake transport (`TRANSPORT`);
- the owner / staff see the plain sentences of services/gemini.py (`ai_not_configured` / `ai_unavailable`), never a variable
  name, a model id or a provider text."""
import logging
import time
from typing import Any

import httpx

from app.core.config import settings
from app.services import gemini

log = logging.getLogger("pos.ai")

XAI_DEFAULT_BASE = "https://api.x.ai/v1"
OPENAI_DEFAULT_BASE = "https://api.openai.com/v1"
TRANSPORT: httpx.BaseTransport | None = None  # tests install an httpx.MockTransport here; production leaves it None
RETRY_STATUS = frozenset({429, 500, 502, 503, 504})


# ---- keys and endpoints (blank settings fall back to the defaults: compose passes unset variables as "") ------------------
def xai_key() -> str:
    return (settings.xai_api_key or settings.grok_api_key or "").strip()


def openai_key() -> str:
    return (settings.openai_api_key or "").strip()


def gemini_key() -> str:
    return (settings.gemini_api_key or "").strip()


def xai_base() -> str:
    return (settings.xai_base_url or XAI_DEFAULT_BASE).strip().rstrip("/")


def openai_base() -> str:
    return (settings.openai_base_url or OPENAI_DEFAULT_BASE).strip().rstrip("/")


def xai_vision_model() -> str:
    return (settings.xai_vision_model or "").strip() or "grok-4.3"


def xai_text_model() -> str:
    return (settings.xai_text_model or "").strip() or xai_vision_model()


def whisper_model() -> str:
    return (settings.whisper_model or "").strip() or "whisper-1"


# ---- selection ---------------------------------------------------------------------------------------------------------
def _choice(value: str, allowed: tuple[str, ...]) -> str:
    v = (value or "auto").strip().lower() or "auto"
    return v if v in allowed or v == "auto" else "auto"  # an unknown value behaves like auto (check_config warns about it)


def ocr_provider() -> str:
    """'xai' or 'gemini'. An explicit choice is kept even when its key is missing (the scan then says 'not set up')."""
    c = _choice(settings.ai_ocr_provider, ("gemini", "xai"))
    return ("xai" if xai_key() else "gemini") if c == "auto" else c


def stt_provider() -> str:
    """'whisper' or 'gemini'."""
    c = _choice(settings.ai_stt_provider, ("gemini", "whisper"))
    return ("whisper" if openai_key() else "gemini") if c == "auto" else c


def text_provider() -> str:
    """'xai' or 'gemini'. auto = gemini (the established path); xai only when asked for."""
    c = _choice(settings.ai_text_provider, ("gemini", "xai"))
    return "gemini" if c == "auto" else c


def other_ocr(provider: str) -> str | None:
    """The provider to fall back to once: the other one, when it has a key."""
    other = "gemini" if provider == "xai" else "xai"
    return other if (gemini_key() if other == "gemini" else xai_key()) else None


def status() -> dict[str, Any]:
    """Booleans and provider names only: what the owner / Super Admin sees ('Scan: Grok, Voice: Whisper'). Never a key."""
    scan, voice = ocr_provider(), stt_provider()
    scan_ok = bool(xai_key() if scan == "xai" else gemini_key() and settings.gemini_model.strip())
    voice_ok = bool(openai_key() if voice == "whisper" else gemini_key() and settings.gemini_model.strip())
    return {
        "scan": {"provider": scan, "label": "Grok" if scan == "xai" else "Gemini", "configured": scan_ok},
        "voice": {"provider": voice, "label": "Whisper" if voice == "whisper" else "Gemini", "configured": voice_ok},
        "text": {"provider": text_provider(), "label": "Grok" if text_provider() == "xai" else "Gemini",
                 "configured": bool(xai_key() if text_provider() == "xai" else gemini_key() and settings.gemini_model.strip())},
        "keys": {"gemini": bool(gemini_key()), "xai": bool(xai_key()), "openai": bool(openai_key())},
        "summary": f"Scan: {'Grok' if scan == 'xai' else 'Gemini'}, Voice: {'Whisper' if voice == 'whisper' else 'Gemini'}",
    }


def startup_warnings() -> list[str]:
    out: list[str] = []
    for name, value, allowed in (("AI_OCR_PROVIDER", settings.ai_ocr_provider, ("gemini", "xai", "auto")),
                                 ("AI_STT_PROVIDER", settings.ai_stt_provider, ("gemini", "whisper", "auto")),
                                 ("AI_TEXT_PROVIDER", settings.ai_text_provider, ("gemini", "xai", "auto"))):
        if (value or "auto").strip().lower() not in allowed:
            out.append(f"{name}={value!r} is not one of {'|'.join(allowed)}: treated as auto")
    if ocr_provider() == "xai" and not xai_key():
        out.append("AI_OCR_PROVIDER=xai but XAI_API_KEY (or GROK_API_KEY) is empty: invoice scans fail as 'not set up'")
    if stt_provider() == "whisper" and not openai_key():
        out.append("AI_STT_PROVIDER=whisper but OPENAI_API_KEY is empty: audio orders fail as 'not set up'")
    if text_provider() == "xai" and not xai_key():
        out.append("AI_TEXT_PROVIDER=xai but XAI_API_KEY (or GROK_API_KEY) is empty: AI text features fail as 'not set up'")
    return out


# ---- HTTP --------------------------------------------------------------------------------------------------------------
def client(timeout: float | None = None) -> httpx.Client:
    if TRANSPORT is None and gemini.in_tests():
        raise RuntimeError("a real AI provider must not be called from tests: install ai_providers.TRANSPORT (a MockTransport)")
    return httpx.Client(transport=TRANSPORT, timeout=timeout or settings.ai_http_timeout_seconds)


def _retry_delay(r: httpx.Response) -> float:
    base = max(0.0, float(settings.ai_retry_backoff_seconds))
    try:
        return min(5.0, max(base, float(r.headers.get("retry-after", 0))))
    except ValueError:
        return base


def post(url: str, key: str, *, json: Any = None, data: dict | None = None, files: dict | None = None,
         timeout: float | None = None) -> httpx.Response:
    """POST with `Authorization: Bearer <key>`; ONE retry after a pause on 429 / 5xx. Returns the response with a 2xx status;
    raises httpx.HTTPStatusError / httpx.HTTPError otherwise (the caller maps it to a plain message; str() of these holds the
    URL and status, never a header, so never the key)."""
    headers = {"Authorization": f"Bearer {key}"}
    with client(timeout) as c:
        r = c.post(url, headers=headers, json=json, data=data, files=files)
        if r.status_code in RETRY_STATUS:
            time.sleep(_retry_delay(r))
            r = c.post(url, headers=headers, json=json, data=data, files=files)
        r.raise_for_status()
        return r


# ---- xAI chat completions (OpenAI compatible) --------------------------------------------------------------------------
def xai_chat(model: str, messages: list[dict], *, json_mode: bool = True, max_tokens: int | None = None,
             timeout: float | None = None) -> str:
    """POST {base}/chat/completions; returns choices[0].message.content. Raises provider errors as documented in `post`."""
    body: dict[str, Any] = {"model": model, "messages": messages, "temperature": 0}
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    if max_tokens:
        body["max_tokens"] = max_tokens
    r = post(f"{xai_base()}/chat/completions", xai_key(), json=body, timeout=timeout)
    return r.json()["choices"][0]["message"]["content"]


def lower_schema(schema: Any) -> Any:
    """The Gemini response schema (OBJECT / STRING / nullable ...) as plain JSON Schema text for a prompt."""
    if isinstance(schema, dict):
        out = {}
        for k, v in schema.items():
            if k == "type" and isinstance(v, str):
                out[k] = v.lower()
            elif k == "nullable":
                continue
            else:
                out[k] = lower_schema(v)
        if schema.get("nullable") and isinstance(out.get("type"), str):
            out["type"] = [out["type"], "null"]
        return out
    if isinstance(schema, list):
        return [lower_schema(x) for x in schema]
    return schema


def strip_fences(text: str) -> str:
    t = (text or "").strip()
    if t.startswith("```"):
        t = t.split("\n", 1)[1] if "\n" in t else t[3:]
        t = t.rsplit("```", 1)[0]
    return t.strip()
