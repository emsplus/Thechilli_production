from app.core.config import settings
from app.providers.base import WhatsAppProvider
from app.providers.meta import MetaWhatsAppProvider
from app.providers.mock import MockProvider

_instance: WhatsAppProvider | None = None


def get_provider() -> WhatsAppProvider:
    global _instance
    if _instance is None:
        if settings.whatsapp_provider == "mock":
            _instance = MockProvider()
        elif settings.whatsapp_provider == "meta":
            _instance = MetaWhatsAppProvider()
        else:
            raise RuntimeError(f"WhatsApp provider {settings.whatsapp_provider!r} is not implemented")
    return _instance


def set_provider(p: WhatsAppProvider | None) -> None:
    global _instance
    _instance = p
