"""Template registry: the single source for message texts AND for what must be registered in Meta (docs/WHATSAPP_TEMPLATES.md,
regenerated with `uv run python scripts/gen_template_doc.py`; a test fails when the doc drifts).

`body` uses {name} placeholders. For Meta they become {{1}}, {{2}}, ... in the order of `variables`. Meta rejects bodies that start
or end with a variable, so every body starts and ends with fixed text.
`essential` messages are still sent to a number that has opted out (STOP): they complete an order the customer already placed.
`template=False` entries are free-text only (customer-service window) and are never registered with Meta.
"""
from dataclasses import dataclass

from app.core.errors import AppError


@dataclass(frozen=True)
class Template:
    name: str
    category: str  # Meta category: UTILITY | MARKETING | AUTHENTICATION
    body: str
    variables: tuple[str, ...]
    essential: bool = False
    registered: bool = True  # False = free text only
    language: str = "en"
    samples: tuple[str, ...] = ()  # example values Meta asks for at registration, same order as `variables`

    def render(self, params: dict) -> str:
        return self.body.format(**{k: params.get(k, "") for k in self.variables})

    def meta_body(self) -> str:
        out = self.body
        for i, v in enumerate(self.variables, 1):
            out = out.replace("{" + v + "}", "{{" + str(i) + "}}")
        return out

    def ordered(self, params: dict) -> list[str]:
        return [str(params.get(v, "")) for v in self.variables]


_T = [
    Template("order_received", "UTILITY",
             "Hi {name}, we got your order {code}. Total ₹{total}. Track it here: {link}\nThank you for ordering!",
             ("name", "code", "total", "link"), samples=("Asha", "D0042", "550.00", "https://example.com/t/abc")),
    Template("order_ready", "UTILITY", "Your order {code} is ready and waiting for a rider. We will update you when it is on the way.",
             ("code",), samples=("D0042",)),
    Template("out_for_delivery", "UTILITY",
             "Order {code} is on the way. Your delivery code is {otp}. Share it with the rider only when the order arrives. "
             "Track it here: {link}\nEnjoy your meal!",
             ("code", "otp", "link"), essential=True, samples=("D0042", "123456", "https://example.com/t/abc")),
    Template("delivered", "UTILITY", "Order {code} was delivered. Thank you for ordering with us!", ("code",), samples=("D0042",)),
    Template("cancelled", "UTILITY", "Order {code} was cancelled. Please contact the restaurant if you have questions.",
             ("code",), samples=("D0042",)),
    Template("rider_offer", "UTILITY", "New delivery {code} to {address}. Open this link to accept or decline: {link}\nOpen it on your phone.",
             ("code", "address", "link"), samples=("D0042", "12 MG Road", "https://example.com/r/abc")),
    Template("manager_alert", "UTILITY", "Alert for order {code}: {reason}. Please check the order.", ("code", "reason"),
             samples=("D0042", "no rider available")),
    Template("rating_request", "UTILITY",
             "Hope you enjoyed order {code}. Please rate it by replying with a number from 1 to 5 (5 is best). Thank you!",
             ("code",), samples=("D0042",)),
    Template("text", "UTILITY", "{body}", ("body",), registered=False),
    # Reply to the customer's own STOP/START keyword: still sent to an opted-out number (it was asked for).
    Template("text_reply", "UTILITY", "{body}", ("body",), essential=True, registered=False),
]
REGISTRY: dict[str, Template] = {t.name: t for t in _T}
assert all(not t.registered or not (t.body.startswith("{") or t.body.endswith("}")) for t in _T)


def get(name: str) -> Template:
    try:
        return REGISTRY[name]
    except KeyError:
        raise AppError(f"unknown message template {name!r}", code="unknown_template", status=500) from None


def sanitize_param(v: object) -> str:
    """Meta rejects newlines, tabs and runs of 4+ spaces inside a template parameter, and empty values."""
    s = " ".join(str(v).replace("\n", " ").replace("\t", " ").split())
    return s[:1000] or "-"
