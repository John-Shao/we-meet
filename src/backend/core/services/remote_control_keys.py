"""Persisted signer selection, bounded public overlap, and emergency fencing.

Private keys are read only from secret configuration. All grant readers take the
state's FOR SHARE lock before accounts/organizations/sessions. Operator changes
take FOR UPDATE before any sessions, so no old-generation grant can commit after
revocation. This is not the Windows Authenticode signing certificate.
"""

import json
import re
from datetime import timedelta

from django.conf import settings
from django.db import connection, transaction
from django.utils import timezone

from core import models
from core.services import remote_control_crypto as crypto
from core.services.remote_control_livekit import RemoteControlError

KID = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")
MAX_KEYS = 8


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError
        result[key] = value
    return result


def configured_keys():
    """Return validated secrets; callers must never log this value or errors."""
    try:
        raw = settings.REMOTE_CONTROL_SIGNING_KEYS
        if raw:
            if not isinstance(raw, str) or len(raw) > 131072:
                raise ValueError
            values = json.loads(raw, object_pairs_hook=_object)
        else:
            values = {
                settings.REMOTE_CONTROL_SIGNING_KID: settings.REMOTE_CONTROL_SIGNING_KEY
            }
        if not isinstance(values, dict) or not 1 <= len(values) <= MAX_KEYS:
            raise ValueError
        for kid, pem in values.items():
            if (
                not isinstance(kid, str)
                or not KID.fullmatch(kid)
                or not isinstance(pem, str)
                or len(pem) > 16384
            ):
                raise ValueError
            crypto.signing_key(pem)
        return values
    except (ValueError, TypeError, crypto.InvalidProof) as exc:
        raise RemoteControlError("signing_unavailable", 503) from exc


def public_key(pem):
    numbers = crypto.signing_key(pem).public_key().public_numbers()
    return {
        "kty": "EC",
        "crv": "P-256",
        "x": crypto.encode64(numbers.x.to_bytes(32, "big")),
        "y": crypto.encode64(numbers.y.to_bytes(32, "big")),
    }


def lock_state(*, required=True):
    """Must precede account locks. Missing initialization never grants input."""
    if not connection.in_atomic_block:
        raise RuntimeError("Signing state lock requires a transaction")
    if connection.vendor != "postgresql":
        raise RemoteControlError("signing_unavailable", 503)
    table = connection.ops.quote_name(models.RemoteControlSigningState._meta.db_table)  # noqa: SLF001 -- Django metadata, not request input.
    with connection.cursor() as cursor:
        cursor.execute(f"SELECT id FROM {table} WHERE id = 1 FOR SHARE")  # noqa: S608
        found = cursor.fetchone()
    state = (
        models.RemoteControlSigningState.objects.select_related("active_key").get(pk=1)
        if found
        else None
    )
    if required and (state is None or state.active_key_id is None):
        raise RemoteControlError("signing_unavailable", 503)
    return state


def signer(state):
    if (
        state is None
        or state.active_key_id is None
        or state.active_key.status != "active"
    ):
        raise RemoteControlError("signing_unavailable", 503)
    pem = configured_keys().get(state.active_key_id)
    if not pem or crypto.digest(public_key(pem)) != state.active_key.fingerprint:
        raise RemoteControlError("signing_unavailable", 503)
    return state.active_key_id, pem


def available():
    if not settings.REMOTE_CONTROL_ENABLED:
        return False
    try:
        state = (
            models.RemoteControlSigningState.objects.select_related("active_key")
            .filter(pk=1)
            .first()
        )
        signer(state)
        return True
    except RemoteControlError:
        return False


@transaction.atomic
def public_ring():
    state = lock_state(required=False)
    if state is None:
        raise RemoteControlError("signing_unavailable", 503)
    entries = list(
        models.RemoteControlSigningKey.objects.filter(
            status__in=["active", "retired"]
        ).order_by("kid")
    )
    if len(entries) > MAX_KEYS:
        raise RemoteControlError("signing_unavailable", 503)
    # Membership stays stable until a revision change. Expired retired keys are
    # included with their deadline until the next operator operation prunes them.
    return {
        "v": 1,
        "revision": state.revision,
        "generation": state.generation,
        "activeKid": state.active_key_id,
        "keys": [
            {
                **key.public_key,
                "kid": key.kid,
                "alg": "ES256",
                "verifyUntil": int(key.verify_until.timestamp())
                if key.verify_until
                else None,
            }
            for key in entries
        ],
    }


@transaction.atomic
def check_configuration(kid):
    """Read-only check of this process's loaded config, not other live workers."""
    state = lock_state(required=False)
    expected = models.RemoteControlSigningKey.objects.filter(pk=kid).first()
    pem = configured_keys().get(kid)
    if (
        not state
        or not expected
        or expected.status not in ("staged", "active")
        or not pem
    ):
        raise RemoteControlError("signing_unavailable", 503)
    fingerprint = crypto.digest(public_key(pem))
    if fingerprint != expected.fingerprint:
        raise RemoteControlError("signing_unavailable", 503)
    return {
        "kid": kid,
        "fingerprint": fingerprint,
        "ready": True,
        "revision": state.revision,
    }


def _audit(state, action, kid, operator, ended=0):
    if not isinstance(operator, str) or not re.fullmatch(
        r"[^\x00-\x1f\x7f]{1,80}", operator
    ):
        raise RemoteControlError("invalid_key_operator", 400)
    models.RemoteControlSigningEvent.objects.create(
        revision=state.revision,
        generation=state.generation,
        action=action,
        kid=kid,
        operator=operator,
        ended_sessions=ended,
    )


def _stage(kid):
    pem = configured_keys().get(kid)
    if not pem:
        raise RemoteControlError("signing_unavailable", 503)
    public = public_key(pem)
    fingerprint = crypto.digest(public)
    existing = models.RemoteControlSigningKey.objects.filter(kid=kid).first()
    if existing:
        if existing.fingerprint != fingerprint or existing.status != "staged":
            raise RemoteControlError("signing_key_reuse_forbidden", 409)
        return existing
    if models.RemoteControlSigningKey.objects.filter(fingerprint=fingerprint).exists():
        raise RemoteControlError("signing_key_reuse_forbidden", 409)
    return models.RemoteControlSigningKey.objects.create(
        kid=kid, public_key=public, fingerprint=fingerprint, status="staged"
    )


@transaction.atomic
def initialize(kid, *, operator):
    if models.RemoteControlSigningState.objects.filter(pk=1).exists():
        raise RemoteControlError("signing_already_initialized", 409)
    key = _stage(kid)
    key.status = "active"
    key.save(update_fields=["status"])
    state = models.RemoteControlSigningState.objects.create(pk=1, active_key=key)
    _audit(state, "initialize", kid, operator)
    return public_ring()


@transaction.atomic
def operate(action, kid, *, revision, operator, replacement=None):  # noqa: PLR0912 -- One explicit atomic operator state machine.
    state = (
        models.RemoteControlSigningState.objects.select_for_update()
        .filter(pk=1)
        .first()
    )
    if state is None:
        raise RemoteControlError("signing_unavailable", 503)
    if type(revision) is not int or state.revision != revision:
        raise RemoteControlError("signing_revision_conflict", 409)
    if (
        action not in ("stage", "activate", "revoke")
        or not isinstance(kid, str)
        or not KID.fullmatch(kid)
    ):
        raise RemoteControlError("invalid_key_operation", 400)
    if replacement is not None and action != "revoke":
        raise RemoteControlError("invalid_key_operation", 400)
    key = (
        _stage(kid)
        if action == "stage"
        else models.RemoteControlSigningKey.objects.filter(pk=kid).first()
    )
    if key is None or key.status in ("expired", "revoked"):
        raise RemoteControlError("signing_key_unavailable", 409)
    now, ended = timezone.now(), 0
    if action == "activate":
        if key.status != "staged":
            raise RemoteControlError("signing_key_unavailable", 409)
        # This worker must already have the exact candidate private key. Other
        # workers missing it fail closed after switching; deploy the key set first.
        _stage(kid)
        models.RemoteControlSigningKey.objects.filter(
            status="retired", verify_until__lte=now
        ).update(status="expired")
        if (
            models.RemoteControlSigningKey.objects.filter(
                status__in=["active", "retired"]
            ).count()
            >= MAX_KEYS
        ):
            raise RemoteControlError("signing_overlap_limit", 409)
        if state.active_key_id:
            models.RemoteControlSigningKey.objects.filter(
                pk=state.active_key_id
            ).update(status="retired", verify_until=now + timedelta(seconds=15))
        key.status, key.verify_until = "active", None
        key.save(update_fields=["status", "verify_until"])
        state.active_key = key
    if action == "revoke":
        substitute = _stage(replacement) if replacement is not None else None
        if substitute and (state.active_key_id != kid or substitute.pk == kid):
            raise RemoteControlError("invalid_key_operation", 400)
        key.status, key.verify_until = "revoked", now
        key.save(update_fields=["status", "verify_until"])
        if state.active_key_id == kid:
            state.active_key = substitute
            if substitute:
                substitute.status = "active"
                substitute.save(update_fields=["status"])
        state.generation += 1
        # Imported lazily to keep the authorization service's dependency acyclic.
        from core.services.remote_control import (  # noqa: PLC0415 -- Break the authorization-service import cycle.
            revoke_by_signing_generation,
        )

        ended = revoke_by_signing_generation(state.generation)
    state.revision += 1
    state.save(update_fields=["active_key", "revision", "generation"])
    _audit(state, action, kid, operator, ended)
    return {**public_ring(), "endedSessions": ended}
