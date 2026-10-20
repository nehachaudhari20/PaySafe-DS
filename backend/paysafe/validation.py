"""Input checks for a simulated payment request."""

import re
from decimal import Decimal

_AMOUNT_PATTERN = re.compile(r"\d+(\.\d{1,2})?")


class InputError(ValueError):
    """The payment form contained a value the API will not accept."""


def parse_amount(value: object) -> Decimal:
    if isinstance(value, bool) or value is None:
        raise InputError("Amount must be a number.")
    if isinstance(value, str):
        raw = value.strip()
    elif isinstance(value, int):
        raw = str(value)
    elif isinstance(value, float):
        raw = str(value)
    elif isinstance(value, Decimal):
        raw = format(value, "f")
    else:
        raise InputError("Amount must be a number.")

    if not _AMOUNT_PATTERN.fullmatch(raw):
        raise InputError("Amount must be a positive number with at most 2 decimal places.")

    amount = Decimal(raw)
    if amount <= 0:
        raise InputError("Amount must be greater than 0.")
    if amount > Decimal("1000000"):
        raise InputError("Amount must be at most 1000000.")
    return amount.quantize(Decimal("0.01"))


def parse_description(value: object) -> str:
    if not isinstance(value, str):
        raise InputError("Description is required.")
    text = value.strip()
    if not text:
        raise InputError("Description is required.")
    if len(text) > 200:
        raise InputError("Description must be at most 200 characters.")
    return text
