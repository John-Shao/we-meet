"""Bounded organization/room policy and the lock shared by all grant paths."""

from uuid import UUID

from django.db import connection

from core import models
from core.services import remote_control_crypto as crypto
from core.services.remote_control_livekit import RemoteControlError

DEFAULTS = {
    "enabled": False,
    "controllers": None,
    "targets": None,
    "max_seconds": 1800,
    "requests_per_minute": 3,
    "rejection_cooldown_seconds": 60,
}
LIMITS = {
    "max_seconds": (30, 1800),
    "requests_per_minute": (1, 10),
    "rejection_cooldown_seconds": (1, 600),
}
MAX_ALLOWLIST = 64


def normalize(value, *, room=False, complete=False):
    """Do not coerce booleans, numeric strings, UUIDs or unknown policy fields."""
    if (
        not isinstance(value, dict)
        or set(value) - set(DEFAULTS)
        or (complete and set(value) != set(DEFAULTS))
    ):
        raise RemoteControlError("invalid_remote_control_policy", 400)
    result = {**DEFAULTS, "enabled": room, **value}
    # An absent room constraint is neutral, including configurable rate limits.
    if room:
        result["requests_per_minute"] = value.get("requests_per_minute", 10)
        result["rejection_cooldown_seconds"] = value.get(
            "rejection_cooldown_seconds", 1
        )
    if type(result["enabled"]) is not bool:
        raise RemoteControlError("invalid_remote_control_policy", 400)
    for field, (lower, upper) in LIMITS.items():
        if type(result[field]) is not int or not lower <= result[field] <= upper:
            raise RemoteControlError("invalid_remote_control_policy", 400)
    for field in ("controllers", "targets"):
        values = result[field]
        if values is None:
            continue
        if not isinstance(values, list) or len(values) > MAX_ALLOWLIST:
            raise RemoteControlError("invalid_remote_control_policy", 400)
        try:
            if any(not isinstance(v, str) or str(UUID(v)) != v for v in values):
                raise ValueError
            if len(set(values)) != len(values):
                raise ValueError
        except (ValueError, TypeError, AttributeError) as exc:
            raise RemoteControlError("invalid_remote_control_policy", 400) from exc
        result[field] = sorted(values)
    return result


def configurations(room):
    try:
        if not isinstance(room.organization.settings, dict) or not isinstance(
            room.configuration, dict
        ):
            raise RemoteControlError("invalid_remote_control_policy", 400)
        return (
            normalize(room.organization.settings.get("remote_control", {})),
            normalize(room.configuration.get("remote_control", {}), room=True),
        )
    except RemoteControlError as exc:
        raise RemoteControlError("invalid_remote_control_policy", 503) from exc


def digest(organization, room):
    # Hash each bounded document first so two full allowlists in each policy do
    # not exceed the wire canonicalizer's 8 KiB message limit when combined.
    return crypto.digest(
        {"organization": crypto.digest(organization), "room": crypto.digest(room)}
    )


def share_organization(organization_id):
    """Grant readers are concurrent; policy UPDATE/DELETE waits for them all.

    Caller must be atomic. Acquire AFTER account locks and BEFORE sessions.
    This matches existing voiceprint/account governance. FOR KEY SHARE is
    insufficient: it permits settings UPDATE. The SQL identifier comes only
    from the model, never a request. Unsupported lock semantics fail closed.
    """
    if not connection.in_atomic_block:
        raise RuntimeError("Remote-control policy lock requires a transaction")
    if not organization_id:
        raise RemoteControlError("remote_control_disabled", 403)
    if connection.vendor == "postgresql":
        table = connection.ops.quote_name(models.Organization._meta.db_table)  # noqa: SLF001 -- Django's documented model metadata API.
        with connection.cursor() as cursor:
            cursor.execute(
                f"SELECT id FROM {table} WHERE id = %s FOR SHARE",  # noqa: S608
                [organization_id],
            )
            found = cursor.fetchone()
    else:
        raise RemoteControlError("policy_locking_unavailable", 503)
    if not found:
        raise RemoteControlError("remote_control_disabled", 403)
