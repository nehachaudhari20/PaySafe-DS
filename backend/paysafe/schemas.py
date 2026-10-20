"""HTTP request and response models."""

from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field, field_serializer, field_validator

from paysafe.validation import parse_amount, parse_description


class PaymentCreate(BaseModel):
    amount: Decimal
    description: str = Field(min_length=1, max_length=200)

    @field_validator("amount", mode="before")
    @classmethod
    def validate_amount(cls, value: object) -> Decimal:
        return parse_amount(value)

    @field_validator("description", mode="before")
    @classmethod
    def validate_description(cls, value: object) -> str:
        return parse_description(value)


class PaymentRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    transaction_id: str
    amount: Decimal
    description: str
    status: str
    worker_id: str | None
    created_at: datetime
    updated_at: datetime

    @field_serializer("amount")
    def serialize_amount(self, value: Decimal) -> str:
        return f"{value:.2f}"

    @field_serializer("created_at", "updated_at")
    def serialize_time(self, value: datetime) -> str:
        return value.isoformat()
