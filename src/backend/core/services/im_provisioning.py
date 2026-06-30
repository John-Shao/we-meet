"""Resolve we-meet Users → jusi-light-im internal uids for admin bridge calls.

jusi's ``conversations.owner_uid`` and ``members.uid`` are jusi's INTERNAL uid (a
UUID v7 minted on first sight), FK'd to ``users(uid)`` — NOT the we-meet ``sub``,
which lives in ``users.external_id``. So before creating a group / adding members
through the admin API, every we-meet User must be mapped to their jusi uid, and the
jusi ``users`` row must exist (or the FK insert 500s).

This is the single source of truth for that mapping. It prefers the cached
``User.im_uid`` (set on first IM token issue — the jusi row already exists, so the
FK is satisfied); on a cache miss it issues a short-lived token, which lazily
registers the user in jusi and returns the uid, then backfills the cache.

Mirrors ``ImViewSet._resolve_uid``/``_cache_im_uid`` but lives in the service layer
so both the meeting-room bridge (``RoomViewSet.im_ensure_group``) and the calendar
reminder job can share it without importing the API layer.

Transport failures (``JusiImUnreachableError`` / ``JusiImBadResponseError``) from
``issue_token`` propagate — callers already wrap the surrounding ``create_group``
in a try/except and map/handle them there.
"""

import logging

logger = logging.getLogger(__name__)

# Short TTL — the token is discarded; we only want the uid + lazy registration.
_RESOLVE_TTL_SECONDS = 60


def external_id_for(user) -> str:
    """Stable opaque identifier for a User: the Keycloak ``sub`` (falls back to pk)."""
    sub = getattr(user, "sub", None)
    return str(sub) if sub else str(user.pk)


def resolve_uid(client, user) -> str | None:
    """Map a we-meet User → their jusi internal uid (cached or minted).

    Returns ``None`` only when the user has no usable external identifier.
    Propagates jusi transport errors from ``issue_token`` on a cache miss.
    """
    cached = getattr(user, "im_uid", None)
    if cached:
        return cached
    external_id = external_id_for(user)
    if not external_id:
        return None
    resolved = client.issue_token(external_id=external_id, ttl_seconds=_RESOLVE_TTL_SECONDS)
    _cache(user, resolved.uid)
    return resolved.uid


def resolve_uids(client, users) -> dict:
    """``{user.pk: jusi uid}`` for each user, resolving each at most once.

    Skips users with no external identifier; propagates jusi transport errors so
    the caller can abort the whole group operation rather than build a partial one.
    """
    out: dict = {}
    seen: set = set()
    for user in users:
        if user is None or user.pk in seen:
            continue
        seen.add(user.pk)
        uid = resolve_uid(client, user)
        if uid:
            out[user.pk] = uid
    return out


def _cache(user, uid: str) -> None:
    """Backfill ``User.im_uid``. Best-effort — a write failure must not break the op."""
    if not uid or getattr(user, "im_uid", None) == uid:
        return
    try:
        user.im_uid = uid
        user.save(update_fields=["im_uid"])
    except Exception:  # noqa: BLE001 — cache write is non-critical
        logger.warning("im: failed to cache im_uid for user %s", user.pk, exc_info=True)
