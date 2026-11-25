"""Regenerates docs/WHATSAPP_TEMPLATES.md from the registry: uv run python scripts/gen_template_doc.py"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.providers.templates import REGISTRY

HEADER = """# WhatsApp templates to register in Meta

Generated from `app/providers/templates.py` by `uv run python scripts/gen_template_doc.py` (a test fails if this file drifts).
Do not edit by hand: change the registry, regenerate, then register the SAME names, language and variable order in
Meta Business Manager (WhatsApp Manager -> Message templates).

How the service uses them
- Inside the 24 hour customer-service window (the customer messaged us in the last 24 h) the service sends **free text**.
- Outside the window Meta only delivers an **approved template**. The service sends the template named below with the
  variables in the listed order. A message whose template is not registered here (or is free-text only) outside the window is
  marked dead with an explicit error instead of being silently dropped.
- If Meta answers error 131047 to a free-text send (our window estimate was off) the same message is re-sent once as its template.
- Names are lower-case with underscores; language `en`. Add a `hi` translation of each with the same name in Meta if you want
  Hindi customer messages (the registry's `language` field and a per-customer locale would then pick it).

Meta rules already respected by these bodies: a variable never starts or ends a body, bodies are under 1024 characters, a
variable value never contains a newline, tab or four spaces in a row (sanitised before sending), and no empty value
(replaced by `-`).

Risks to check at submission
- `out_for_delivery` carries a one-time delivery code. Submit it as UTILITY; if Meta re-categorises it as AUTHENTICATION or
  rejects it, switch to a code-only authentication template (copy-code button) and keep the tracking link in a separate message.
- Meta may re-categorise any template to MARKETING (different pricing and opt-in rules). Review the category it assigns.
- Opted-out numbers (STOP) get only the `essential` templates below.

"""


def render() -> str:
    out = [HEADER, "| Name | Category | Variables (in order) | Essential |\n|---|---|---|---|"]
    regs = [t for t in REGISTRY.values() if t.registered]
    for t in regs:
        out.append(f"| `{t.name}` | {t.category} | {', '.join(f'{{{{{i}}}}}={v}' for i, v in enumerate(t.variables, 1))} | "
                   f"{'yes' if t.essential else 'no'} |")
    out.append("\n## Bodies (paste into Meta)\n")
    for t in regs:
        out.append(f"### `{t.name}`  ({t.category}, `{t.language}`)\n\n```\n{t.meta_body()}\n```\n")
        out.append("Sample values for Meta's review form: " + "; ".join(
            f"{{{{{i}}}}}=`{s}`" for i, s in enumerate(t.samples, 1)) + "\n")
    free = [t.name for t in REGISTRY.values() if not t.registered]
    out.append("## Free-text only (never registered)\n\n" + ", ".join(f"`{n}`" for n in free)
               + ". Used for replies inside the 24 hour window (menu link, order status, STOP/START confirmations).\n")
    out.append("## Environment\n\n`WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN` (system-user token with "
               "`whatsapp_business_messaging`), `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`; `WHATSAPP_PROVIDER=meta`.\n")
    return "\n".join(out)


if __name__ == "__main__":
    Path(__file__).resolve().parent.parent.joinpath("docs/WHATSAPP_TEMPLATES.md").write_text(render())
