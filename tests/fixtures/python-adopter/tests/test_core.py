# The entry point these tests drive is `place`, at src/orders/core.py:4-6.
from orders.core import place


def test_placing_twice_records_once():
    """[ORD-1] Placing the same order twice records one order.

    The second call returns the order the first one recorded, not a copy of it.
    """
    assert place("a", "book") is place("a", "book")


def test_a_different_order_is_recorded_separately():
    """A second order id is a second order."""
    order = place("b", "pen")
    # A fixture string, not a citation: "[ORD-1]" here locks nothing.
    assert order == {"id": "b", "item": "pen"}
