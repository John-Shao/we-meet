"""Account admission for new agent features; independent of ordinary Work."""

import uuid

from django.conf import settings


def allows(user):
    """Closed by default; malformed allowlists deny the entire cohort."""
    if not (
        user
        and user.is_authenticated
        and user.is_active
        and user.sub
        and not user.is_device
    ):
        return False
    mode = settings.WORK_AGENT_ROLLOUT_MODE
    if mode == "all":
        return True
    if mode != "allowlist":
        return False
    identifiers = settings.WORK_AGENT_ALLOWED_USER_IDS
    if not isinstance(identifiers, (list, tuple)) or not 1 <= len(identifiers) <= 100:
        return False
    try:
        cohort = {uuid.UUID(str(value)) for value in identifiers}
        return uuid.UUID(str(user.pk)) in cohort
    except (ValueError, TypeError, AttributeError):
        return False
