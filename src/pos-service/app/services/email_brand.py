"""TheChilli.ai email layout (docs/EMAIL.md): one HTML frame for every system email, plus the plain-text footer.

Brand (brand/BRAND.md): white background, text wordmark "the" + "chilli" (Chilli Red #E50914) + "." (orange) + "ai" in Dark
Charcoal #111820, Chilli Red buttons with a white bold label, Inter with system font fallbacks, footer 'thechilli.ai'.
No images, no remote fonts or resources, no tracking: table layout with inline styles so mail clients render it alike.
Every caller-supplied value is HTML-escaped here or by the caller (helpers below escape)."""
import html

RED = "#E50914"
CHARCOAL = "#111820"
ORANGE = "#FF5A1F"
MUTED = "#5B6470"
LINE = "#E6E8EB"
FONT = "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
WORDMARK_FONT = "Poppins,'Arial Black',Inter,Helvetica,Arial,sans-serif"
SITE = "thechilli.ai"
TEXT_FOOTER = f"--\nTheChilli.ai - AI Agents for Restaurants\n{SITE}"

esc = html.escape


def wordmark() -> str:
    return (f'<span style="font-family:{WORDMARK_FONT};font-weight:800;font-size:24px;letter-spacing:-0.5px;'
            f'color:{CHARCOAL}">the<span style="color:{RED}">chilli</span><span style="color:{ORANGE}">.</span>ai</span>')


def p(text: str, muted: bool = False, size: int = 15) -> str:
    color = MUTED if muted else CHARCOAL
    return f'<p style="margin:0 0 14px;font-size:{size}px;line-height:1.55;color:{color}">{esc(text)}</p>'


def button(url: str, label: str) -> str:
    return (f'<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 18px"><tr>'
            f'<td style="background:{RED};border-radius:8px">'
            f'<a href="{esc(url, quote=True)}" style="display:inline-block;padding:12px 22px;font-family:{FONT};'
            f'font-size:15px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:8px">{esc(label)}</a>'
            f'</td></tr></table>'
            f'<p style="margin:0 0 14px;font-size:12px;color:{MUTED};word-break:break-all">{esc(url)}</p>')


def code(value: str) -> str:
    """A one-time code, large and spaced (digits only, so nothing to escape beyond the usual)."""
    return (f'<div style="margin:8px 0 18px;padding:14px 18px;border:1px solid {LINE};border-radius:10px;display:inline-block;'
            f'font-family:{FONT};font-size:32px;font-weight:700;letter-spacing:8px;color:{CHARCOAL};'
            f'font-variant-numeric:tabular-nums">{esc(value)}</div>')


def table(rows: list[tuple[str, str]], heading: str | None = None) -> str:
    """Two-column key/value table (label left, value right, tabular numbers)."""
    out = ['<table role="presentation" cellpadding="0" cellspacing="0" width="100%" '
           'style="border-collapse:collapse;margin:0 0 18px;font-size:14px">']
    if heading:
        out.append(f'<tr><td colspan="2" style="padding:8px 0;font-weight:700;color:{CHARCOAL};'
                   f'border-bottom:2px solid {RED}">{esc(heading)}</td></tr>')
    for k, v in rows:
        out.append(f'<tr><td style="padding:7px 0;color:{MUTED};border-bottom:1px solid {LINE}">{esc(k)}</td>'
                   f'<td align="right" style="padding:7px 0;color:{CHARCOAL};font-weight:600;'
                   f'font-variant-numeric:tabular-nums;border-bottom:1px solid {LINE}">{esc(v)}</td></tr>')
    out.append("</table>")
    return "".join(out)


def grid(header: list[str], rows: list[list[str]], heading: str | None = None) -> str:
    """A small multi-column table; the first column is left aligned, the others right aligned."""
    def cell(v: str, i: int, th: bool) -> str:
        align = "left" if i == 0 else "right"
        style = (f"padding:7px 6px;text-align:{align};border-bottom:1px solid {LINE};"
                 + (f"color:{MUTED};font-weight:600;font-size:12px" if th else f"color:{CHARCOAL}"))
        return f'<td style="{style};font-variant-numeric:tabular-nums">{esc(v)}</td>'
    out = []
    if heading:
        out.append(f'<p style="margin:0 0 6px;font-size:14px;font-weight:700;color:{CHARCOAL}">{esc(heading)}</p>')
    out.append('<table role="presentation" cellpadding="0" cellspacing="0" width="100%" '
               'style="border-collapse:collapse;margin:0 0 18px;font-size:14px">')
    out.append("<tr>" + "".join(cell(h, i, True) for i, h in enumerate(header)) + "</tr>")
    for r in rows:
        out.append("<tr>" + "".join(cell(v, i, False) for i, v in enumerate(r)) + "</tr>")
    out.append("</table>")
    return "".join(out)


def layout(title: str, body_html: str, preheader: str = "", footer_note: str | None = None) -> str:
    """The whole HTML document. `body_html` is already-escaped HTML built with the helpers above."""
    note = p(footer_note, muted=True, size=12) if footer_note else ""
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        f'<meta name="color-scheme" content="light"><title>{esc(title)}</title></head>'
        f'<body style="margin:0;padding:0;background:#F5F6F7;font-family:{FONT};color:{CHARCOAL}">'
        f'<span style="display:none;max-height:0;overflow:hidden;opacity:0">{esc(preheader)}</span>'
        '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#F5F6F7"><tr>'
        '<td align="center" style="padding:24px 12px">'
        '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" '
        'style="max-width:600px;background:#FFFFFF;border-radius:12px;overflow:hidden;border:1px solid #E6E8EB">'
        f'<tr><td style="padding:22px 28px;border-bottom:3px solid {RED}">{wordmark()}</td></tr>'
        f'<tr><td style="padding:26px 28px 10px;font-family:{FONT}">'
        f'<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:{CHARCOAL}">{esc(title)}</h1>'
        f'{body_html}{note}</td></tr>'
        f'<tr><td style="padding:16px 28px 22px;border-top:1px solid {LINE};font-size:12px;color:{MUTED};font-family:{FONT}">'
        f'TheChilli.ai &middot; AI Agents for Restaurants<br>'
        f'<a href="https://{SITE}" style="color:{RED};text-decoration:none;font-weight:600">{SITE}</a></td></tr>'
        '</table></td></tr></table></body></html>')
