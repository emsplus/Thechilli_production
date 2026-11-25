from app.core.config import settings
from app.providers.base import ProviderAdapter
from app.providers.mock import MockProvider


class Registry:
    def __init__(self, adapters: list[ProviderAdapter] | None = None):
        self._a = {a.name: a for a in (adapters or [])}

    def get(self, name: str) -> ProviderAdapter | None:
        return self._a.get(name)

    def names(self) -> list[str]:
        return sorted(self._a)


def default_registry() -> Registry:
    # Real adapters get added here once credentials + specs exist. The mock is opt-in and refused in production.
    return Registry([MockProvider()] if settings.enable_mock_provider else [])
