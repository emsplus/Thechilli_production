"""Runs the delivery webhook outbox in the foreground (alternative to the in-process runner; set
DELIVERY_OUTBOX_SWEEP_SECONDS=0 on the API when you run this). `--once` = a single pass (cron)."""
import sys
import time

from app.core.config import settings
from app.services import delivery_outbox

if __name__ == "__main__":
    while True:
        n = delivery_outbox.run_once()
        if "--once" in sys.argv:
            print(f"delivered {n}")
            break
        time.sleep(max(settings.delivery_outbox_sweep_seconds, 1))
