"""GST breakup in integer paise. The RATE, SAC and seller state are CONFIGURATION (settings.gst_*), not embedded rules.
Mechanics only: tax = round-half-up(taxable * rate_bps / 10000); same-state supply splits it CGST/SGST (CGST gets the floor
half, SGST the remainder so the parts always sum to the total); inter-state supply is all IGST.
NEEDS CA VERIFICATION before production: rate, SAC, place-of-supply handling, rounding, invoice numbering, reverse charge."""
from dataclasses import dataclass


@dataclass(frozen=True)
class GstBreakup:
    taxable_paise: int
    cgst_paise: int
    sgst_paise: int
    igst_paise: int

    @property
    def tax_paise(self) -> int:
        return self.cgst_paise + self.sgst_paise + self.igst_paise

    @property
    def total_paise(self) -> int:
        return self.taxable_paise + self.tax_paise


def compute_gst(taxable_paise: int, rate_bps: int, supplier_state: str, buyer_state: str) -> GstBreakup:
    if taxable_paise < 0 or rate_bps < 0:
        raise ValueError("negative amount or rate")
    tax = (taxable_paise * rate_bps + 5000) // 10000
    if supplier_state == buyer_state:
        cgst = tax // 2
        return GstBreakup(taxable_paise, cgst, tax - cgst, 0)
    return GstBreakup(taxable_paise, 0, 0, tax)
