class TaxError(ValueError):
    """Invalid input or configuration. `status` mirrors pos-service's TaxError (422 bad input, 409 config)."""

    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.status = status
