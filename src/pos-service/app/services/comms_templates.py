"""Email templates (English and Hindi): plain text + HTML for the password reset link, the 'password changed' notice and the
'new device sign-in' notice. No images, no tracking pixels, no remote resources; every inserted value is HTML-escaped and
single-lined. `render(kind, locale, **vars)` -> (subject, text, html). Unknown locales fall back to English."""
import html
from datetime import datetime

from app.services.mail import clean

LOCALES = ("en", "hi")

_T: dict[str, dict[str, dict]] = {
    "password_reset": {
        "en": {
            "subject": "Reset your password - {restaurant}",
            "greet": "Hello {name},",
            "lines": ["We received a request to reset the password of your account at {restaurant}.",
                      "Open this link to choose a new password. It works once and expires in {minutes} minutes:"],
            "button": "Choose a new password",
            "foot": ["If you did not ask for this, ignore this email: your password stays the same."],
        },
        "hi": {
            "subject": "अपना पासवर्ड रीसेट करें - {restaurant}",
            "greet": "नमस्ते {name},",
            "lines": ["{restaurant} पर आपके खाते का पासवर्ड रीसेट करने का अनुरोध मिला है।",
                      "नया पासवर्ड चुनने के लिए यह लिंक खोलें। यह केवल एक बार काम करेगा और {minutes} मिनट में समाप्त हो जाएगा:"],
            "button": "नया पासवर्ड चुनें",
            "foot": ["यदि आपने यह अनुरोध नहीं किया है, तो इस ईमेल को अनदेखा करें: आपका पासवर्ड नहीं बदलेगा।"],
        },
    },
    "password_changed": {
        "en": {
            "subject": "Your password was changed - {restaurant}",
            "greet": "Hello {name},",
            "lines": ["The password of your account at {restaurant} was just changed, and you were signed out on all devices."],
            "foot": ["If this was not you, ask your restaurant owner to reset your password right away."],
        },
        "hi": {
            "subject": "आपका पासवर्ड बदल दिया गया है - {restaurant}",
            "greet": "नमस्ते {name},",
            "lines": ["{restaurant} पर आपके खाते का पासवर्ड अभी बदला गया है और आप सभी डिवाइस से साइन-आउट कर दिए गए हैं।"],
            "foot": ["यदि यह आपने नहीं किया है, तो अपने रेस्तरां के मालिक से तुरंत पासवर्ड रीसेट करने को कहें।"],
        },
    },
    "register_attempt": {
        "en": {
            "subject": "Someone tried to register a restaurant with your email",
            "greet": "Hello,",
            "lines": ["Someone just tried to register a new restaurant using this email address, which already has an account.",
                      "We did not create it. If this was you, sign in with your existing account, or register again using the "
                      "same password as that account to add another restaurant."],
            "foot": ["If this was not you, no action is needed: nothing changed on your account."],
        },
        "hi": {
            "subject": "किसी ने आपके ईमेल से रेस्तरां रजिस्टर करने की कोशिश की",
            "greet": "नमस्ते,",
            "lines": ["किसी ने अभी इस ईमेल पते से एक नया रेस्तरां रजिस्टर करने की कोशिश की, जिसका खाता पहले से मौजूद है।",
                      "हमने इसे नहीं बनाया। यदि यह आप थे, तो अपने मौजूदा खाते से साइन-इन करें।"],
            "foot": ["यदि यह आप नहीं थे, तो कुछ करने की आवश्यकता नहीं है: आपके खाते में कुछ नहीं बदला।"],
        },
    },
    "staff_invite": {
        "en": {
            "subject": "You have been added to {restaurant}",
            "greet": "Hello {name},",
            "lines": ["You have been added as staff at {restaurant}.",
                      "Open this link to choose your password. It works once and expires in {hours} hours:"],
            "button": "Choose my password",
            "foot": ["To sign in on the waiter app or the counter, use the restaurant code {code} with your email and the "
                     "password you choose.", "If you do not work at {restaurant}, ignore this email."],
        },
        "hi": {
            "subject": "आपको {restaurant} में जोड़ा गया है",
            "greet": "नमस्ते {name},",
            "lines": ["आपको {restaurant} में स्टाफ के रूप में जोड़ा गया है।",
                      "अपना पासवर्ड चुनने के लिए यह लिंक खोलें। यह केवल एक बार काम करेगा और {hours} घंटे में समाप्त हो जाएगा:"],
            "button": "मेरा पासवर्ड चुनें",
            "foot": ["वेटर ऐप या काउंटर पर साइन-इन के लिए रेस्तरां कोड {code}, अपना ईमेल और चुना हुआ पासवर्ड इस्तेमाल करें।",
                     "यदि आप {restaurant} में काम नहीं करते हैं, तो इस ईमेल को अनदेखा करें।"],
        },
    },
    "new_device": {
        "en": {
            "subject": "New sign-in to your account - {restaurant}",
            "greet": "Hello {name},",
            "lines": ["Your account at {restaurant} was just signed in to from a new device:", "{device}", "Time: {when}"],
            "foot": ["If this was you, no action is needed. If not, change your password now."],
        },
        "hi": {
            "subject": "आपके खाते में नया साइन-इन - {restaurant}",
            "greet": "नमस्ते {name},",
            "lines": ["{restaurant} पर आपके खाते में अभी एक नए डिवाइस से साइन-इन हुआ:", "{device}", "समय: {when}"],
            "foot": ["यदि यह आप थे, तो कुछ करने की आवश्यकता नहीं है। यदि नहीं, तो अभी अपना पासवर्ड बदलें।"],
        },
    },
}


def languages_enabled() -> bool:
    from app.core.config import settings
    return bool(settings.comms_enable_languages)


def effective_language(requested: str | None) -> str:
    """English unless COMMS_ENABLE_LANGUAGES=1 (owner decision 2026-10-31: English only for now); then the requested one."""
    return requested if languages_enabled() and requested in LOCALES else "en"


def pick_locale(*candidates: str | None) -> str:
    """First supported language among candidates (e.g. a request field, then an Accept-Language header). Always 'en' while
    COMMS_ENABLE_LANGUAGES is off (the default), whatever the request or its Accept-Language header says."""
    if not languages_enabled():
        return "en"
    for c in candidates:
        for part in (c or "").lower().replace(";", ",").split(","):
            code = part.strip().split("-")[0].strip()
            if code in LOCALES:
                return code
    return "en"


def render(kind: str, locale: str, link: str | None = None, **v) -> tuple[str, str, str]:
    t = _T[kind][effective_language(locale)]
    vals = {k: clean(str(x), 200) for k, x in v.items()}
    vals["name"] = vals.get("name") or "Guest"
    sub = clean(t["subject"].format(**vals))
    esc = html.escape
    lines = [ln.format(**vals) for ln in t["lines"]]
    foot = [ln.format(**vals) for ln in t["foot"]]
    greet = t["greet"].format(**vals)
    from app.services import email_brand as B  # TheChilli.ai frame (docs/EMAIL.md)
    text = "\n".join([greet, "", *lines, *([link] if link else []), "", *foot, "", vals.get("restaurant", ""), "",
                      B.TEXT_FOOTER]) + "\n"
    body = B.p(greet) + "".join(B.p(ln) for ln in lines)
    if link:
        body += B.button(link, t["button"])
    body += "".join(B.p(ln, muted=True) for ln in foot)
    if vals.get("restaurant"):
        body += f'<p style="margin:0 0 14px;font-size:15px;font-weight:700">{esc(vals["restaurant"])}</p>'
    page = B.layout(sub, body, preheader=lines[0] if lines else sub)
    return sub, text, page


def when(dt: datetime) -> str:
    return dt.strftime("%d %b %Y %H:%M %Z").strip()
