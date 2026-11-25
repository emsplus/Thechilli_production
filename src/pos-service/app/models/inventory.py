"""Stock locations, batches, unit conversions, purchase orders, goods receipts, purchase returns, supplier ledger and stock
counts (docs/INVENTORY.md). The ledger itself (`stock_movements`) and the item master live in models/core.py.

Every table carries `restaurant_id` (RLS, app/core/rls.py LATER_DIRECT_TABLES). Tables that belong to one outlet also carry
`outlet_id` with the composite FK (outlet_id, restaurant_id) -> outlets, so an outlet of another tenant is impossible."""
import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean, CheckConstraint, Date, DateTime, ForeignKey, ForeignKeyConstraint, Index, Integer, Numeric, String, Text,
    UniqueConstraint, func, text as text_,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, fk, outlet_col, uuid_pk

QTY3 = Numeric(14, 3)
COST4 = Numeric(12, 4)
MONEY2 = Numeric(12, 2)

LOCATION_KINDS = ("store", "kitchen", "bar", "cold_room", "prep")
PO_STATUSES = ("draft", "sent", "partially_received", "closed", "cancelled")


class StockLocation(Base, TimestampMixin):
    """A place stock is kept, inside one outlet. Every outlet has exactly one default location (created with the outlet);
    bills consume from the default location of the outlet they were sold in."""
    __tablename__ = "stock_locations"
    __table_args__ = (
        UniqueConstraint("outlet_id", "name"),
        Index("one_default_location", "outlet_id", unique=True, postgresql_where=text_("is_default")),
        CheckConstraint("kind IN ('store','kitchen','bar','cold_room','prep')", name="ck_stock_locations_kind"),
    )
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    outlet_id: Mapped[uuid.UUID] = outlet_col()
    name: Mapped[str] = mapped_column(String(80))
    kind: Mapped[str] = mapped_column(String(12), default="store", server_default="store")
    is_default: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")


class StockBalance(Base):
    """Balance of one item in one location. Maintained by the stock_movements trigger, never written by code."""
    __tablename__ = "stock_balances"
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    item_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("inventory_items.id"), primary_key=True)
    location_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("stock_locations.id"), primary_key=True)
    balance: Mapped[Decimal] = mapped_column(QTY3, default=0, server_default="0")


class StockBatch(Base, TimestampMixin):
    """A lot of one item received into one location, with its expiry. `remaining` is kept by the ledger trigger."""
    __tablename__ = "stock_batches"
    __table_args__ = (UniqueConstraint("item_id", "location_id", "batch_no"),)
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    item_id: Mapped[uuid.UUID] = fk("inventory_items")
    location_id: Mapped[uuid.UUID] = fk("stock_locations")
    batch_no: Mapped[str] = mapped_column(String(60))
    expiry_date: Mapped[date | None] = mapped_column(Date, index=True)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    supplier_id: Mapped[uuid.UUID | None] = fk("suppliers", nullable=True)
    unit_cost: Mapped[Decimal | None] = mapped_column(COST4)  # per base unit
    qty_received: Mapped[Decimal] = mapped_column(QTY3, default=0, server_default="0")
    remaining: Mapped[Decimal] = mapped_column(QTY3, default=0, server_default="0")


class ItemUnitConversion(Base):
    """`1 <unit_code> = factor_to_base base units` for one item (1 case = 24 pcs). Quantities are always stored in the base unit."""
    __tablename__ = "item_unit_conversions"
    __table_args__ = (UniqueConstraint("item_id", "unit_code"), CheckConstraint("factor_to_base > 0", name="ck_conversion_positive"))
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    item_id: Mapped[uuid.UUID] = fk("inventory_items")
    unit_code: Mapped[str] = mapped_column(String(20))
    factor_to_base: Mapped[Decimal] = mapped_column(Numeric(14, 6))


class PurchaseOrder(Base, TimestampMixin):
    __tablename__ = "purchase_orders"
    __table_args__ = (
        UniqueConstraint("restaurant_id", "number"),
        CheckConstraint("status IN ('draft','sent','partially_received','closed','cancelled')", name="ck_purchase_orders_status"),
    )
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    outlet_id: Mapped[uuid.UUID] = outlet_col()
    supplier_id: Mapped[uuid.UUID] = fk("suppliers")
    number: Mapped[str] = mapped_column(String(20))
    status: Mapped[str] = mapped_column(String(20), default="draft", server_default="draft")
    expected_date: Mapped[date | None] = mapped_column(Date)
    notes: Mapped[str | None] = mapped_column(String(500))
    subtotal: Mapped[Decimal] = mapped_column(MONEY2, default=0)
    tax_total: Mapped[Decimal] = mapped_column(MONEY2, default=0)
    total: Mapped[Decimal] = mapped_column(MONEY2, default=0)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[uuid.UUID | None] = fk("users", nullable=True)
    lines: Mapped[list["PurchaseOrderLine"]] = relationship(cascade="all, delete-orphan", order_by="PurchaseOrderLine.position")


class PurchaseOrderLine(Base):
    __tablename__ = "purchase_order_lines"
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    po_id: Mapped[uuid.UUID] = fk("purchase_orders")
    position: Mapped[int] = mapped_column(Integer)
    item_id: Mapped[uuid.UUID] = fk("inventory_items")
    unit_code: Mapped[str] = mapped_column(String(20))
    factor_to_base: Mapped[Decimal] = mapped_column(Numeric(14, 6))  # base units per ordered unit, frozen at order time
    quantity: Mapped[Decimal] = mapped_column(QTY3)  # ordered, in unit_code
    unit_price: Mapped[Decimal] = mapped_column(COST4)  # per unit_code, tax excluded
    tax_rate: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=0)
    received_quantity: Mapped[Decimal] = mapped_column(QTY3, default=0, server_default="0")  # accepted so far, in unit_code


class GoodsReceipt(Base, TimestampMixin):
    """A delivery against a purchase order. Posting it adds stock; it is never edited (a mistake is a purchase return)."""
    __tablename__ = "goods_receipts"
    __table_args__ = (UniqueConstraint("restaurant_id", "number"), UniqueConstraint("restaurant_id", "idempotency_key"))
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    outlet_id: Mapped[uuid.UUID] = outlet_col()
    po_id: Mapped[uuid.UUID] = fk("purchase_orders")
    supplier_id: Mapped[uuid.UUID] = fk("suppliers")
    location_id: Mapped[uuid.UUID] = fk("stock_locations")
    number: Mapped[str] = mapped_column(String(20))
    idempotency_key: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    received_on: Mapped[date] = mapped_column(Date)
    supplier_invoice_no: Mapped[str | None] = mapped_column(String(100))
    # The supplier's bill as scanned under Purchases (purchase_invoices), when linked: at receive time or later with
    # POST /goods-receipts/{id}/link-purchase. The double-post guard uses it when the bill number was not typed in.
    purchase_invoice_id: Mapped[uuid.UUID | None] = fk("purchase_invoices", nullable=True)
    note: Mapped[str | None] = mapped_column(String(300))
    subtotal: Mapped[Decimal] = mapped_column(MONEY2, default=0)
    tax_total: Mapped[Decimal] = mapped_column(MONEY2, default=0)
    total: Mapped[Decimal] = mapped_column(MONEY2, default=0)
    created_by: Mapped[uuid.UUID | None] = fk("users", nullable=True)
    lines: Mapped[list["GoodsReceiptLine"]] = relationship(cascade="all, delete-orphan", order_by="GoodsReceiptLine.position")


class GoodsReceiptLine(Base):
    __tablename__ = "goods_receipt_lines"
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    grn_id: Mapped[uuid.UUID] = fk("goods_receipts")
    position: Mapped[int] = mapped_column(Integer)
    po_line_id: Mapped[uuid.UUID] = fk("purchase_order_lines")
    item_id: Mapped[uuid.UUID] = fk("inventory_items")
    unit_code: Mapped[str] = mapped_column(String(20))
    quantity: Mapped[Decimal] = mapped_column(QTY3)  # accepted, in unit_code
    rejected_quantity: Mapped[Decimal] = mapped_column(QTY3, default=0, server_default="0")  # refused at the door: no stock
    quantity_base: Mapped[Decimal] = mapped_column(QTY3)  # accepted, base unit: what the ledger got
    unit_price: Mapped[Decimal] = mapped_column(COST4)  # rate per unit_code, tax excluded
    unit_cost: Mapped[Decimal] = mapped_column(COST4)  # per base unit
    tax_rate: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=0)
    net: Mapped[Decimal] = mapped_column(MONEY2)
    tax_amount: Mapped[Decimal] = mapped_column(MONEY2, default=0)
    batch_id: Mapped[uuid.UUID | None] = fk("stock_batches", nullable=True)
    batch_no: Mapped[str | None] = mapped_column(String(60))
    expiry_date: Mapped[date | None] = mapped_column(Date)
    returned_base: Mapped[Decimal] = mapped_column(QTY3, default=0, server_default="0")  # sent back so far (purchase returns)


class PurchaseReturn(Base, TimestampMixin):
    __tablename__ = "purchase_returns"
    __table_args__ = (UniqueConstraint("restaurant_id", "number"), UniqueConstraint("restaurant_id", "idempotency_key"))
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    outlet_id: Mapped[uuid.UUID] = outlet_col()
    grn_id: Mapped[uuid.UUID] = fk("goods_receipts")
    supplier_id: Mapped[uuid.UUID] = fk("suppliers")
    location_id: Mapped[uuid.UUID] = fk("stock_locations")
    number: Mapped[str] = mapped_column(String(20))  # debit note number
    idempotency_key: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    reason: Mapped[str] = mapped_column(String(300))
    subtotal: Mapped[Decimal] = mapped_column(MONEY2, default=0)
    tax_total: Mapped[Decimal] = mapped_column(MONEY2, default=0)
    total: Mapped[Decimal] = mapped_column(MONEY2, default=0)
    created_by: Mapped[uuid.UUID | None] = fk("users", nullable=True)
    lines: Mapped[list["PurchaseReturnLine"]] = relationship(cascade="all, delete-orphan", order_by="PurchaseReturnLine.position")


class PurchaseReturnLine(Base):
    __tablename__ = "purchase_return_lines"
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    return_id: Mapped[uuid.UUID] = fk("purchase_returns")
    position: Mapped[int] = mapped_column(Integer)
    grn_line_id: Mapped[uuid.UUID] = fk("goods_receipt_lines")
    item_id: Mapped[uuid.UUID] = fk("inventory_items")
    quantity_base: Mapped[Decimal] = mapped_column(QTY3)
    unit_cost: Mapped[Decimal] = mapped_column(COST4)
    net: Mapped[Decimal] = mapped_column(MONEY2)
    tax_amount: Mapped[Decimal] = mapped_column(MONEY2, default=0)
    batch_id: Mapped[uuid.UUID | None] = fk("stock_batches", nullable=True)


class SupplierLedgerEntry(Base):
    """Append-only account of what the restaurant owes a supplier: + goods received, - returns and payments, +/- adjustments.
    Balance = SUM(amount). Rows are never edited; a mistake is a new, opposite entry."""
    __tablename__ = "supplier_ledger"
    __table_args__ = (
        Index("uq_supplier_ledger_ref", "restaurant_id", "entry_type", "ref_id", unique=True, postgresql_where=text_("ref_id IS NOT NULL")),
        CheckConstraint("entry_type IN ('grn','return','payment','adjustment')", name="ck_supplier_ledger_type"),
    )
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    supplier_id: Mapped[uuid.UUID] = fk("suppliers")
    entry_type: Mapped[str] = mapped_column(String(12))
    amount: Mapped[Decimal] = mapped_column(MONEY2)  # signed; positive = we owe more
    entry_date: Mapped[date] = mapped_column(Date)
    ref_type: Mapped[str | None] = mapped_column(String(20))
    ref_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    note: Mapped[str | None] = mapped_column(String(300))
    created_by: Mapped[uuid.UUID | None] = fk("users", nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)


class StockCount(Base, TimestampMixin):
    """A stocktake of one location: lines hold what was counted; posting compares with the ledger and posts the variance."""
    __tablename__ = "stock_counts"
    __table_args__ = (CheckConstraint("status IN ('open','posted')", name="ck_stock_counts_status"),)
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    outlet_id: Mapped[uuid.UUID] = outlet_col()
    location_id: Mapped[uuid.UUID] = fk("stock_locations")
    name: Mapped[str | None] = mapped_column(String(120))
    status: Mapped[str] = mapped_column(String(10), default="open", server_default="open")
    created_by: Mapped[uuid.UUID | None] = fk("users", nullable=True)
    posted_by: Mapped[uuid.UUID | None] = fk("users", nullable=True)
    posted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    lines: Mapped[list["StockCountLine"]] = relationship(cascade="all, delete-orphan")


class StockCountLine(Base):
    __tablename__ = "stock_count_lines"
    __table_args__ = (UniqueConstraint("count_id", "item_id"),)
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    count_id: Mapped[uuid.UUID] = fk("stock_counts")
    item_id: Mapped[uuid.UUID] = fk("inventory_items")
    counted_base: Mapped[Decimal] = mapped_column(QTY3)
    expected_base: Mapped[Decimal | None] = mapped_column(QTY3)  # ledger balance when posted
    variance: Mapped[Decimal | None] = mapped_column(QTY3)  # counted - expected


# Outlet-scoped tables of this module: composite FK (outlet_id, restaurant_id) -> outlets, like core.OUTLET_TABLES.
STOCK_OUTLET_TABLES: tuple[str, ...] = ("stock_locations", "purchase_orders", "goods_receipts", "purchase_returns", "stock_counts")
for _t in STOCK_OUTLET_TABLES:
    Base.metadata.tables[_t].append_constraint(ForeignKeyConstraint(
        ["outlet_id", "restaurant_id"], ["outlets.id", "outlets.restaurant_id"], name=f"fk_{_t}_outlet"))

NEW_TABLES: tuple[str, ...] = (
    "stock_locations", "stock_balances", "stock_batches", "item_unit_conversions", "purchase_orders", "purchase_order_lines",
    "goods_receipts", "goods_receipt_lines", "purchase_returns", "purchase_return_lines", "supplier_ledger", "stock_counts",
    "stock_count_lines",
)
