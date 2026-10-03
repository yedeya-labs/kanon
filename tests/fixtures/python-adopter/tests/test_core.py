from orders.core import place


def test_ord_1_placing_the_same_order_twice_records_one_order():
    """[ORD-1]"""
    assert place("a", "book") is place("a", "book")
