"""TheChilli.ai email frame (same layout as pos-service app/services/email_brand.py; brand/BRAND.md): text wordmark header,
Chilli Red #E50914 button with a white bold label, Inter with system fallbacks, footer 'thechilli.ai'. No images, no remote
resources, no tracking; every inserted value is escaped by the helpers."""
import html

RED, CHARCOAL, ORANGE, MUTED, LINE = "#E50914", "#111820", "#FF5A1F", "#5B6470", "#E6E8EB"
FONT = "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
WORDMARK_FONT = "Poppins,'Arial Black',Inter,Helvetica,Arial,sans-serif"
SITE = "thechilli.ai"
TEXT_FOOTER = f"--\nTheChilli.ai - AI Agents for Restaurants\n{SITE}"
esc = html.escape


def p(text: str, muted: bool = False, size: int = 15) -> str:
    return f'<p style="margin:0 0 14px;font-size:{size}px;line-height:1.55;color:{MUTED if muted else CHARCOAL}">{esc(text)}</p>'


def button(url: str, label: str) -> str:
    return (f'<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 18px"><tr>'
            f'<td style="background:{RED};border-radius:8px"><a href="{esc(url, quote=True)}" style="display:inline-block;'
            f'padding:12px 22px;font-family:{FONT};font-size:15px;font-weight:700;color:#FFFFFF;text-decoration:none;'
            f'border-radius:8px">{esc(label)}</a></td></tr></table>'
            f'<p style="margin:0 0 14px;font-size:12px;color:{MUTED};word-break:break-all">{esc(url)}</p>')


def layout(title: str, body_html: str, preheader: str = "") -> str:
    wordmark = (f'<span style="font-family:{WORDMARK_FONT};font-weight:800;font-size:24px;letter-spacing:-0.5px;'
                f'color:{CHARCOAL}">the<span style="color:{RED}">chilli</span><span style="color:{ORANGE}">.</span>ai</span>')
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
        f'<tr><td style="padding:22px 28px;border-bottom:3px solid {RED}">{wordmark}</td></tr>'
        f'<tr><td style="padding:26px 28px 10px;font-family:{FONT}">'
        f'<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:{CHARCOAL}">{esc(title)}</h1>{body_html}</td></tr>'
        f'<tr><td style="padding:16px 28px 22px;border-top:1px solid {LINE};font-size:12px;color:{MUTED};font-family:{FONT}">'
        f'TheChilli.ai &middot; AI Agents for Restaurants<br>'
        f'<a href="https://{SITE}" style="color:{RED};text-decoration:none;font-weight:600">{SITE}</a></td></tr>'
        '</table></td></tr></table></body></html>')
