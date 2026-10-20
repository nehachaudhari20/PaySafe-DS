"""Payment input rules."""

from decimal import Decimal

import pytest

from paysafe.validation import InputError, parse_amount, parse_description


def test_parse_amount_accepts_whole_numbers_and_cents():
    assert parse_amount("12") == Decimal("12.00")
    assert parse_amount("12.5") == Decimal("12.50")
    assert parse_amount(8) == Decimal("8.00")


@pytest.mark.parametrize(
    ("value", "message"),
    [
        ("0", "greater than 0"),
        ("0.00", "greater than 0"),
        ("-5", "at most 2 decimal places"),
        ("10.999", "at most 2 decimal places"),
        ("1000000.01", "at most 1000000"),
        ("abc", "at most 2 decimal places"),
        (None, "must be a number"),
    ],
)
def test_parse_amount_rejects_invalid_values(value, message):
    with pytest.raises(InputError, match=message):
        parse_amount(value)


def test_parse_description_strips_whitespace():
    assert parse_description("  lab fee  ") == "lab fee"


@pytest.mark.parametrize("value", ["", "   ", None, 12])
def test_parse_description_requires_text(value):
    with pytest.raises(InputError, match="required"):
        parse_description(value)


def test_parse_description_limits_length():
    with pytest.raises(InputError, match="200"):
        parse_description("a" * 201)
