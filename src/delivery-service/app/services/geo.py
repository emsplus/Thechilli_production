"""Distance and location parsing helpers (pure functions)."""
import math
import re

_EARTH_KM = 6371.0088


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lng2 - lng1) / 2) ** 2
    return 2 * _EARTH_KM * math.asin(min(1.0, math.sqrt(a)))


def valid_pin(lat: float | None, lng: float | None) -> bool:
    return lat is not None and lng is not None and math.isfinite(lat) and math.isfinite(lng) \
        and -90 <= lat <= 90 and -180 <= lng <= 180 and not (lat == 0 and lng == 0)


_PAIR = r"(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})"
_PLAIN = re.compile(rf"^\s*{_PAIR}\s*$")
_LINK = re.compile(rf"(?:maps|goo\.gl|google)[^\s]*?(?:[?&@/]|q=|ll=|query=|destination=)\s*{_PAIR}", re.IGNORECASE)


def pin_from_text(text: str) -> tuple[float, float] | None:
    """A pin pasted as text: a bare "26.91, 75.78" or a Google Maps link carrying coordinates."""
    if len(text) > 600:
        return None
    m = _PLAIN.match(text) or _LINK.search(text)
    if not m:
        return None
    lat, lng = float(m.group(1)), float(m.group(2))
    return (lat, lng) if valid_pin(lat, lng) else None


def delivery_check(cfg: dict, lat: float | None, lng: float | None) -> tuple[str, float | None]:
    """Against the outlet's radius from the POS config (`outlet_lat`, `outlet_lng`, `delivery_radius_km`).
    Returns ("unchecked"|"ok"|"outside"|"need_location", distance_km). Compared on the exact distance."""
    try:
        olat, olng, radius = float(cfg["outlet_lat"]), float(cfg["outlet_lng"]), float(cfg["delivery_radius_km"])
    except (KeyError, TypeError, ValueError):
        return "unchecked", None
    if radius <= 0 or not valid_pin(olat, olng):
        return "unchecked", None
    if not valid_pin(lat, lng):
        return "need_location", None
    d = haversine_km(olat, olng, lat, lng)
    return ("ok" if d <= radius else "outside"), d
