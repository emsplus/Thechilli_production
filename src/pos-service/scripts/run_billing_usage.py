"""Sends the PAYG usage outbox to platform-core in the foreground (alternative to the in-process runner; set
BILLING_USAGE_SWEEP_SECONDS=0 on the API when you run this). `--once` = a single pass (cron). docs/PAYG_BILLING.md."""
import sys
import time

from app.core.config import settings
from app.services import wallet

if __name__ == "__main__":
    while True:
        n = wallet.run_once()
        if "--once" in sys.argv:
            print(f"sent {n}")
            break
        time.sleep(max(settings.billing_usage_sweep_seconds, 1))
