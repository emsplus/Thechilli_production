"""The single place that talks to Google's Gemini REST API (voice, OCR, recipes, owner chat go through here).

Rules enforced here, not left to callers:
- the model id comes from configuration (GEMINI_MODEL and the per-feature overrides). There is NO built-in default: an
  unset id fails the call with 503 and `startup_warnings()` says so at boot;
- the real API is never called from a test run (PYTEST_CURRENT_TEST / TEST_FORBID_AI) - tests use the Fake providers;
- provider errors are logged by type only, never with request bodies (orders, bills and recordings contain personal data).

Model ids last checked 2026-10-30 against https://ai.google.dev/gemini-api/docs/models, /changelog and /deprecations:
gemini-3.8-flash (stable, GA 2026-09-02, no shutdown date), gemini-3.6-flash, gemini-3.5-flash-lite (stable, GA 2026-07-21),
gemini-3.1-flash-lite (stable, shutdown no earlier than 2027-05-07, Google recommends gemini-3.5-flash-lite),
gemini-3-flash-preview (preview). gemini-2.0-flash(-lite) and gemini-3.1-flash-lite-preview are shut down.
Re-check that page before changing KNOWN_MODELS; the list only drives a warning, it never blocks a call."""
import logging
import os
from typing import Any

import httpx
from fastapi import HTTPException

from app.core.config import settings

log = logging.getLogger("pos.gemini")

KNOWN_MODELS = frozenset({"gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite",
                          "gemini-3-flash-preview", "gemini-2.5-flash", "gemini-2.5-flash-lite"})
SHUT_DOWN = frozenset({"gemini-2.0-flash", "gemini-2.0-flash-lite", "gemini-3.1-flash-lite-preview"})
CHECKED_ON = "2026-10-30"
ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"


# ---- what an owner or staff member may see -------------------------------------------------------------------------
# Never an environment variable name, a model id or a raw exception text: those go to the log only (startup_warnings() and
# the callers' log lines tell the operator). The client gets a plain sentence and a stable `error.code`.
NOT_SET_UP = "ai_not_configured"    # 503: no API key / model id on this server
UNAVAILABLE = "ai_unavailable"      # 502: the provider failed or answered with something unusable
_NOT_SET_UP_TEXT = {
    "ask": "Ask-AI is not set up yet. Ask your account manager to turn it on.",
    "recipe": "Recipe suggestions with AI are not set up yet. Ask your account manager to turn them on.",
    "ocr": "Invoice scanning is not set up yet. Ask your account manager to turn it on. You can still enter the invoice by hand.",
    "voice": "Voice ordering from audio is not set up yet. Ask your account manager to turn it on. You can type the order instead.",
    "ai": "AI is not set up yet. Ask your account manager to turn it on.",
}
_UNAVAILABLE_TEXT = {
    "ask": "Ask-AI could not answer just now. Please try again in a few minutes.",
    "recipe": "Recipe suggestions could not be made just now. Please try again in a few minutes.",
    "ocr": "The invoice could not be read automatically. You can try again in a few minutes or enter it by hand.",
    "voice": "Voice ordering could not understand that just now. Please try again or type the order.",
    "ai": "The AI service could not answer just now. Please try again in a few minutes.",
}


class AiError(HTTPException):
    """An AI failure with a plain message and a stable code (the error handler puts `code` into `error.code`)."""

    def __init__(self, status_code: int, message: str, code: str):
        super().__init__(status_code, message)
        self.code = code


def not_set_up(feature: str = "ai") -> AiError:
    return AiError(503, _NOT_SET_UP_TEXT.get(feature, _NOT_SET_UP_TEXT["ai"]), NOT_SET_UP)


def unavailable(feature: str = "ai", cause: BaseException | None = None) -> AiError:
    """The provider failed. Only the exception TYPE is logged (requests and replies hold orders, bills and recordings)."""
    log.warning("AI provider error (%s): %s", feature, type(cause).__name__ if cause is not None else "unexpected reply")
    return AiError(502, _UNAVAILABLE_TEXT.get(feature, _UNAVAILABLE_TEXT["ai"]), UNAVAILABLE)


def owner_text(feature: str, code: str | None) -> str | None:
    """The plain sentence of a code, for stored messages (e.g. a failed invoice scan)."""
    table = {NOT_SET_UP: _NOT_SET_UP_TEXT, UNAVAILABLE: _UNAVAILABLE_TEXT}.get(code or "")
    return table.get(feature, table["ai"]) if table else None


def scan_error_code(error: str | None) -> str | None:
    """Stable code of a stored scan error. Rows stored before this change hold raw exception text: those are shown as the
    generic sentence (see public_scan_error), so any non-empty error has a code."""
    if not error:
        return None
    return NOT_SET_UP if error == owner_text("ocr", NOT_SET_UP) else UNAVAILABLE


def public_scan_error(error: str | None) -> str | None:
    """A stored error as shown to the owner: rows written before the plain wording hold e.g. 'RuntimeError: GEMINI_API_KEY is not
    configured' or a provider exception; those are replaced by the matching plain sentence."""
    if not error or error in (owner_text("ocr", NOT_SET_UP), owner_text("ocr", UNAVAILABLE)):
        return error
    legacy_not_set_up = any(k in error for k in ("GEMINI_", "not configured", "is not configured"))
    return owner_text("ocr", NOT_SET_UP if legacy_not_set_up else UNAVAILABLE)


def in_tests() -> bool:
    return bool(os.environ.get("PYTEST_CURRENT_TEST") or os.environ.get("TEST_FORBID_AI"))


def resolve_model(*specific: str, feature: str = "ai") -> str:
    """The first non-empty id among the feature override(s), then GEMINI_MODEL. 503 `ai_not_configured` (plain message, no
    variable names) when none is configured; `startup_warnings()` tells the operator."""
    for m in (*specific, settings.gemini_model):
        if m and m.strip():
            return m.strip()
    raise not_set_up(feature)


def startup_warnings() -> list[str]:
    ids = {"GEMINI_MODEL": settings.gemini_model, "GEMINI_VOICE_MODEL": settings.gemini_voice_model,
           "GEMINI_RECIPE_MODEL": settings.gemini_recipe_model, "GEMINI_OCR_FAST_MODEL": settings.gemini_ocr_fast_model}
    out: list[str] = []
    if settings.gemini_api_key and not settings.gemini_model.strip():
        out.append("GEMINI_API_KEY is set but GEMINI_MODEL is empty: every AI call (OCR, recipes, chat, voice with "
                   "VOICE_PROVIDER=gemini) fails with 503 until a model id is configured")
    for k, v in ids.items():
        v = (v or "").strip()
        if v in SHUT_DOWN:
            out.append(f"{k}={v} has been shut down by Google")
        elif v and v not in KNOWN_MODELS:
            out.append(f"{k}={v} is not in the list of ids verified on {CHECKED_ON} (see app/services/gemini.py)")
    if settings.voice_provider == "gemini" and not settings.gemini_api_key:
        out.append("VOICE_PROVIDER=gemini but GEMINI_API_KEY is empty: audio orders return 503")
    return out


def log_startup_warnings() -> None:
    from app.services import ai_providers  # imported here: ai_providers imports this module
    for w in startup_warnings() + ai_providers.startup_warnings():
        log.warning("AI config: %s", w)


def generate(model: str, body: dict, *, timeout: float = 60, thinking: str = "", feature: str = "ai") -> dict:
    """POST generateContent; returns the response JSON. Retries once without thinkingConfig when the model rejects it.
    Raises httpx.HTTPError on transport/status errors (callers map it to their own 502)."""
    if not settings.gemini_api_key:
        raise not_set_up(feature)
    if in_tests():
        raise RuntimeError("the real Gemini API must not be called from tests: use the Fake provider")
    gen: dict[str, Any] = body.setdefault("generationConfig", {})
    if thinking:
        gen["thinkingConfig"] = {"thinkingLevel": thinking}
    url, headers = ENDPOINT.format(model=model), {"x-goog-api-key": settings.gemini_api_key}
    r = httpx.post(url, json=body, headers=headers, timeout=timeout)
    if r.status_code == 400 and "thinkingConfig" in gen:
        gen.pop("thinkingConfig")
        r = httpx.post(url, json=body, headers=headers, timeout=timeout)
    r.raise_for_status()
    return r.json()


def first_text(resp: dict) -> str:
    return resp["candidates"][0]["content"]["parts"][0]["text"]
