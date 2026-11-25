import uuid
from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.deps import P, Principal, require_feature, require_perm
from app.core.db import get_db
from app.schemas.expenses import ExpenseIn, ExpenseOut, ExpensePatch, ExpenseSummary
from app.services import expenses as svc

router = APIRouter(tags=["expenses"], dependencies=[Depends(require_feature("expenses"))])


@router.get("/expenses", response_model=list[ExpenseOut])
def list_expenses(start: date | None = Query(None, alias="from"), end: date | None = Query(None, alias="to"),
                  category: str | None = None, p: Principal = Depends(require_perm(P.EXPENSES_MANAGE)), db: Session = Depends(get_db)):
    """Newest first. Bills that are not stock: utilities, telecom, rent, cleaning ..."""
    return svc.listing(db, p, start, end, category)


@router.get("/expenses/summary", response_model=ExpenseSummary)
def expense_summary(start: date | None = Query(None, alias="from"), end: date | None = Query(None, alias="to"),
                    p: Principal = Depends(require_perm(P.EXPENSES_MANAGE)), db: Session = Depends(get_db)):
    return svc.summary(db, p, start, end)


@router.post("/expenses", response_model=ExpenseOut, status_code=201)
def create_expense(data: ExpenseIn, p: Principal = Depends(require_perm(P.EXPENSES_MANAGE)), db: Session = Depends(get_db)):
    """Never posts stock. With `invoice_id` the scanned invoice is filed under this expense."""
    return svc.create(db, p, data)


@router.patch("/expenses/{expense_id}", response_model=ExpenseOut)
def update_expense(expense_id: uuid.UUID, data: ExpensePatch, p: Principal = Depends(require_perm(P.EXPENSES_MANAGE)),
                   db: Session = Depends(get_db)):
    return svc.update(db, p, expense_id, data)
