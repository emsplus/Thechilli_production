from app.providers.base import InboundMessageEvent, OutboundRequest, ProviderError, StatusEvent, WhatsAppProvider
from app.providers.meta import MetaWhatsAppProvider


class MockProvider(WhatsAppProvider):
    """Records messages in memory. Not a network client: nothing is ever delivered to a phone.

    Inbound payloads have the Meta Cloud API shape (parsing is shared with the real adapter):
    {"entry":[{"changes":[{"value":{"metadata":{"phone_number_id":..},"messages":[{"id","from","type","text":{"body"}}]}}]}]}
    """

    def __init__(self):
        self.sent: list[OutboundRequest] = []
        self.fail_next: list[ProviderError] = []
        self._n = 0
        self._parser = MetaWhatsAppProvider(access_token="mock")

    def send(self, req: OutboundRequest) -> str:
        if self.fail_next:
            raise self.fail_next.pop(0)
        self.sent.append(req)
        self._n += 1
        return f"mock-wamid-{self._n}"

    def parse_webhook(self, payload: dict) -> list[InboundMessageEvent]:
        return self._parser.parse_webhook(payload)

    def parse_statuses(self, payload: dict) -> list[StatusEvent]:
        return self._parser.parse_statuses(payload)
