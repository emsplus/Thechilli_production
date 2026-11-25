#!/usr/bin/env python3
"""One tiny REAL call per configured AI provider; prints OK / FAIL per provider and never a key.

Run on the server, where the environment (or compose/.env.secrets) holds the keys:

    docker compose exec pos-service python scripts/check_ai_keys.py            # all configured providers
    docker compose exec pos-service python scripts/check_ai_keys.py --vision   # xAI-compatible: also reads a 64x64 test image
    docker compose exec pos-service python scripts/check_ai_keys.py --stt      # OpenAI: transcribe 1 s of silence (else: list models)

Cost: a few tokens per provider (the --stt call is one second of audio). Exit code 0 = every configured provider is OK (or none
is configured: that is reported as SKIP), 1 = at least one FAIL. Output holds provider names, model ids and HTTP status codes only.
"""
import argparse
import base64
import io
import struct
import sys
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.services import ai_providers as ap, gemini  # noqa: E402


def _probe_png(size: int = 64) -> bytes:
    """A size x size RGB PNG (white with a dark square), built with zlib only. Some OpenAI-compatible vision endpoints
    (Groq) reject tiny images such as 1x1, so the probe uses 64 x 64."""
    import struct
    import zlib

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    rows = b"".join(
        b"\x00" + b"".join(b"\x20\x20\x20" if 16 <= x < 48 and 16 <= y < 48 else b"\xff\xff\xff" for x in range(size))
        for y in range(size))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b""))


_PNG = _probe_png()


def silent_wav(seconds: int = 1, rate: int = 16000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(struct.pack("<h", 0) * rate * seconds)
    return buf.getvalue()


def why(e: BaseException) -> str:
    if isinstance(e, httpx.HTTPStatusError):
        return f"HTTP {e.response.status_code}"
    return type(e).__name__  # never str(e): it may hold a URL


def check_gemini() -> str:
    model = gemini.resolve_model(feature="ai")
    gemini.generate(model, {"contents": [{"parts": [{"text": "Reply with the word ok."}]}],
                            "generationConfig": {"maxOutputTokens": 8, "temperature": 0}}, timeout=30)
    return f"model {model}"


def check_xai(vision: bool) -> str:
    model = ap.xai_vision_model()
    content: list | str = "Reply with the word ok."
    if vision:
        content = [{"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(_PNG).decode()}},
                   {"type": "text", "text": "Reply with the word ok."}]
    ap.xai_chat(model, [{"role": "user", "content": content}], json_mode=False, max_tokens=1, timeout=30)
    return f"model {model}" + (", image input" if vision else "")


def check_openai(stt: bool) -> str:
    key = ap.openai_key()
    if stt:
        model = ap.whisper_model()
        ap.post(f"{ap.openai_base()}/audio/transcriptions", key, data={"model": model, "response_format": "json"},
                files={"file": ("silence.wav", silent_wav(), "audio/wav")}, timeout=60)
        return f"model {model}, 1 s silent wav transcribed"
    with ap.client(30) as c:
        r = c.get(f"{ap.openai_base()}/models", headers={"Authorization": f"Bearer {key}"})
        r.raise_for_status()
    return "models listed"


def main() -> int:
    ap_ = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap_.add_argument("--vision", action="store_true", help="xAI-compatible provider: send a 64x64 test image too")
    ap_.add_argument("--stt", action="store_true", help="OpenAI: transcribe one second of silence instead of listing models")
    a = ap_.parse_args()
    jobs = []
    if ap.gemini_key():
        jobs.append(("Gemini", check_gemini))
    if ap.xai_key():
        jobs.append(("xAI (Grok)", lambda: check_xai(a.vision)))
    if ap.openai_key():
        jobs.append(("OpenAI (Whisper)", lambda: check_openai(a.stt)))
    st = ap.status()
    print(f"Selected: {st['summary']}   (AI_OCR_PROVIDER={settings.ai_ocr_provider or 'auto'}, "
          f"AI_STT_PROVIDER={settings.ai_stt_provider or 'auto'}, AI_TEXT_PROVIDER={settings.ai_text_provider or 'auto'})")
    for w in gemini.startup_warnings() + ap.startup_warnings():
        print("WARNING:", w)
    if not jobs:
        print("SKIP: no provider key is configured")
        return 0
    failed = 0
    for name, fn in jobs:
        try:
            print(f"OK    {name}: {fn()}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"FAIL  {name}: {why(e)}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
