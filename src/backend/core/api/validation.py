"""Small, shared validators for hand-written API views."""

from rest_framework import serializers

_BOOLEAN_FIELD = serializers.BooleanField()


def parse_boolean(value) -> bool:
    """Parse a DRF boolean value and reject ambiguous containers/strings."""
    return _BOOLEAN_FIELD.run_validation(value)
