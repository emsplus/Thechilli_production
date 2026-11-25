"""Untrusted text (what staff said, OCR of a bill, a model's free-text field) is DATA. This module neutralises it before it
reaches a model prompt and before any free text the model returns reaches a KOT or a screen. It cannot make a prompt
injection impossible - the real defences are structural: the model only chooses menu refs from a closed list, the server
validates every ref against the tenant's menu, quantities are clamped, prices never come from the model, and nothing is
written until a person confirms - but it removes the obvious payloads and flags them for the audit trail."""
import re
import unicodedata

_CONTROL = re.compile(r"[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤﻿]")
# Phrases that address the model rather than describe food. Kept short and conservative: a waiter never says these.
_INSTRUCTIONS = re.compile(
    r"(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|the)\b[^.\n]{0,40}"
    r"\b(instruction|instructions|prompt|rules?|constraints?)\b"
    r"|\b(system|developer|assistant)\s*(prompt|message|instruction)s?\b"
    r"|\b(you are now|act as|pretend (to be|you are)|new instructions?|jailbreak|developer mode)\b"
    r"|\b(reveal|print|show|repeat)\b[^.\n]{0,30}\b(prompt|instructions|api key|secret|password)\b"
    r"|\b(set|change|make|apply)\b[^.\n]{0,20}\b(price|discount|total)\b[^.\n]{0,20}\b(to|as|zero|free|0)\b"
    r"|\b(100\s*%|hundred percent|full)\s*(discount|off)\b|\bfree of charge\b"
    r"|\bcall (the )?(function|tool|api)\b|\bsudo\b|\brm -rf\b|\bdrop table\b"
    r"|<\s*/?\s*(system|assistant|user|instructions?|script)\b[^>]*>|\[/?(system|inst)\]|```|\{\{|\}\}|<<<|>>>"
    r"|\b(system|assistant|developer)\s*:|^\s*user\s*:",
    re.IGNORECASE | re.MULTILINE)
REMOVED = "[removed]"


def clean_untrusted(value: str | None, limit: int) -> tuple[str, bool]:
    """-> (clean text, injection_suspected). NFKC-normalised, control / zero-width / bidi characters dropped, whitespace
    collapsed, instruction-like phrases and prompt delimiters replaced by [removed], cut to `limit` characters."""
    if not isinstance(value, str):
        return "", False
    t = unicodedata.normalize("NFKC", value)
    t = _CONTROL.sub(" ", t)
    t = " ".join(t.split())
    flagged = bool(_INSTRUCTIONS.search(t))
    if flagged:
        t = " ".join(_INSTRUCTIONS.sub(f" {REMOVED} ", t).split())
    return t[:limit], flagged


def fence(data: str) -> str:
    """The data block put in a prompt: delimiters inside the data cannot close it."""
    return "<<<ORDER_DATA\n" + data.replace("<<<", "").replace(">>>", "") + "\nORDER_DATA>>>"
