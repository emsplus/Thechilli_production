"""Public one-time-code endpoints (docs/EMAIL.md): sign-up email verification and password reset by code.
Kept out of auth.py so the two evolve without merge conflicts; same /auth prefix."""
import uuid

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, EmailStr, Field, model_validator
from sqlalchemy.orm import Session

from app.core import password_policy
from app.core.db import get_db
from app.schemas.common import TokenOut
from app.services import account_otp

router = APIRouter(prefix="/auth", tags=["auth"])


class VerifyEmailIn(BaseModel):
    email: EmailStr
    otp: str = Field(min_length=1, max_length=12)


class EmailOnlyIn(BaseModel):
    email: EmailStr
    restaurant_id: uuid.UUID | None = None  # password reset only: just that restaurant's account


class ResetVerifyIn(BaseModel):
    email: EmailStr
    otp: str = Field(min_length=1, max_length=12)


class ResetVerifyOut(BaseModel):
    reset_token: str
    expires_in_seconds: int


class ResetCompleteIn(BaseModel):
    email: EmailStr
    reset_token: str = Field(min_length=20, max_length=100)
    new_password: str = Field(min_length=10, max_length=256)

    @model_validator(mode="after")
    def _password_policy(self):  # security review finding 7: the code flow follows the same password policy as the link flow
        password_policy.validate(self.new_password, self.email)
        return self


@router.post("/verify-email", response_model=TokenOut)
def verify_email(data: VerifyEmailIn, request: Request, db: Session = Depends(get_db)):
    """Public. Finishes a sign-up: the 6-digit code emailed by POST /auth/register-restaurant (202). Creates the restaurant,
    its owner and default outlet and returns the session. Every failure is the same 400; 5 wrong codes kill the code."""
    return account_otp.verify_signup(db, data.email, data.otp, request)


@router.post("/verify-email/resend")
def resend_verification(data: EmailOnlyIn, request: Request, db: Session = Depends(get_db)):
    """Public. A new code for the newest pending sign-up of this email (one per 60 s). Same answer whether or not one exists."""
    return account_otp.resend_signup(db, data.email, request)


@router.post("/password-reset/request")
def password_reset_request(data: EmailOnlyIn, request: Request, db: Session = Depends(get_db)):
    """Public. ALWAYS the same 200: a 6-digit code is emailed only when an active account has this email."""
    return account_otp.request_reset(db, data.email, request, data.restaurant_id)


@router.post("/password-reset/verify", response_model=ResetVerifyOut)
def password_reset_verify(data: ResetVerifyIn, request: Request, db: Session = Depends(get_db)):
    """Public. Checks the code (single use, 5 tries) and returns a reset token valid 10 minutes for /password-reset/complete."""
    return account_otp.verify_reset(db, data.email, data.otp, request)


@router.post("/password-reset/complete", status_code=204)
def password_reset_complete(data: ResetCompleteIn, request: Request, db: Session = Depends(get_db)):
    """Public. Sets the new password on every active account of this email (or only the requested restaurant's), signs it
    out everywhere and emails a 'password changed' notice."""
    account_otp.complete_reset(db, data.email, data.reset_token, data.new_password, request)
    return Response(status_code=204)
