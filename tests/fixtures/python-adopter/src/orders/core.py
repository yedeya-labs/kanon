_orders: dict[str, dict] = {}


def place(order_id: str, item: str) -> dict:
    """Records an order once, however many times it is placed ([ORD-1])."""
    return _orders.setdefault(order_id, {"id": order_id, "item": item})
