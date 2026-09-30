"""Shared canonical identity validation."""

import uuid


def canonical_uuid(value):
    """Require a canonical, nonzero UUID string."""
    if (
        not isinstance(value, str)
        or str(uuid.UUID(value)) != value
        or uuid.UUID(value).int == 0
    ):
        raise ValueError("Invalid interpretation identity")
    return value
