"""Lease key rotation with real keys/database and isolated LiveKit evidence."""

import io
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Event
from unittest.mock import patch

from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import close_old_connections, connection, transaction
from django.utils import timezone

import jwt
import pytest
from cryptography.hazmat.primitives import serialization

from core import models
from core.services import remote_control as remote
from core.services import remote_control_keys as keys
from core.services.remote_control_livekit import RemoteControlError
from core.tests.services.test_remote_control import (
    active,
    client,
    create,
    keypair,
    meeting,
    proof,
    prove,
)
from core.tests.services.test_remote_control_policy import _blocked

pytestmark = pytest.mark.django_db


def next_key(settings, kid="next-key"):
    private, _ = keypair()
    pem = private.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    settings.REMOTE_CONTROL_SIGNING_KEYS = json.dumps(
        {
            settings.REMOTE_CONTROL_SIGNING_KID: settings.REMOTE_CONTROL_SIGNING_KEY,
            kid: pem,
        }
    )
    return private


def operate(action, kid="next-key", **options):
    return keys.operate(
        action,
        kid,
        revision=keys.public_ring()["revision"],
        operator="isolated-test",
        **options,
    )


def test_rotation_keeps_old_verification_window_and_renews_with_new_key(
    meeting, settings
):
    m = meeting
    previous = active(m)
    newer = next_key(settings)
    staged = operate("stage")
    assert len(staged["keys"]) == 1
    before = int(timezone.now().timestamp())
    switched = operate("activate")
    after = int(timezone.now().timestamp())
    assert switched["generation"] == 1 and switched["activeKid"] == "next-key"
    old = next(
        key
        for key in switched["keys"]
        if key["kid"] == settings.REMOTE_CONTROL_SIGNING_KID
    )
    assert before + 15 <= old["verifyUntil"] <= after + 15
    assert (
        old["verifyUntil"]
        >= jwt.decode(previous["lease"], options={"verify_signature": False})["exp"]
    )
    result = prove(m, previous["session"], "lease")
    assert jwt.get_unverified_header(result["lease"])["kid"] == "next-key"
    assert jwt.decode(
        result["lease"],
        newer.public_key(),
        algorithms=["ES256"],
        audience="we-meet.remote-control.v1",
    )
    assert result["session"]["signingGeneration"] == 1
    assert result["keyRing"]["revision"] == switched["revision"]
    replay = client(m.a).get(m.url + result["session"]["id"] + "/").data
    assert replay["keyRing"] == result["keyRing"]
    assert "PRIVATE KEY" not in json.dumps(switched)


def test_revocation_ends_sessions_and_cannot_replay_old_proof(meeting, settings):
    m = meeting
    row = prove(m, create(m), "prepare")["session"]
    body, _ = proof(m, row, "approve")
    granted = (
        client(m.b).post(m.url + row["id"] + "/approve/", body, format="json").data
    )
    next_key(settings)
    result = operate(
        "revoke", settings.REMOTE_CONTROL_SIGNING_KID, replacement="next-key"
    )
    assert result["generation"] == 2 and result["endedSessions"] == 1
    assert {key["kid"] for key in result["keys"]} == {"next-key"}
    replay = client(m.b).post(m.url + row["id"] + "/approve/", body, format="json").data
    assert replay["session"]["state"] == "ENDED" and "lease" not in replay
    assert granted["session"]["signingGeneration"] == 1
    # New request IDs get generation 2 and still require both prepare/approve.
    fresh = create(m)
    assert fresh["signingGeneration"] == 2 and fresh["state"] == "PENDING"
    assert not models.RemoteControlSession.objects.filter(state="ACTIVE").exists()


def test_revocation_without_replacement_disables_grants(meeting, settings):
    active(meeting)
    result = operate("revoke", settings.REMOTE_CONTROL_SIGNING_KID)
    assert result["activeKid"] is None and result["keys"] == []
    assert not remote.enabled()
    response = client(meeting.a).get(meeting.url + "capabilities/")
    assert response.data["enabled"] is False


def test_kid_and_material_reuse_are_forbidden(meeting, settings):
    next_key(settings)
    operate("stage")
    original = json.loads(settings.REMOTE_CONTROL_SIGNING_KEYS)
    settings.REMOTE_CONTROL_SIGNING_KEYS = json.dumps(
        {**original, "next-key": original[settings.REMOTE_CONTROL_SIGNING_KID]}
    )
    with pytest.raises(RemoteControlError, match="signing_key_reuse_forbidden"):
        operate("activate")
    settings.REMOTE_CONTROL_SIGNING_KEYS = json.dumps(
        {**original, "alias-key": original[settings.REMOTE_CONTROL_SIGNING_KID]}
    )
    with pytest.raises(RemoteControlError, match="signing_key_reuse_forbidden"):
        operate("stage", "alias-key")
    operate("revoke", settings.REMOTE_CONTROL_SIGNING_KID, replacement="next-key")
    with pytest.raises(RemoteControlError, match="signing_key_reuse_forbidden"):
        operate("stage", settings.REMOTE_CONTROL_SIGNING_KID)


def test_old_worker_missing_new_private_key_fails_closed(meeting, settings):
    m = meeting
    row = active(m)["session"]
    next_key(settings)
    operate("stage")
    operate("activate")
    settings.REMOTE_CONTROL_SIGNING_KEYS = ""
    assert not remote.enabled()
    response = client(m.b).post(
        m.url + row["id"] + "/authorization-challenge/",
        {
            "purpose": "lease",
            "stateVersion": row["stateVersion"],
        },
        format="json",
    )
    assert response.status_code == 403 and "lease" not in response.data


def test_stale_operator_revision_and_audit_failure_do_not_partially_revoke(
    meeting, settings
):
    m = meeting
    row = active(m)["session"]
    with pytest.raises(RemoteControlError, match="signing_revision_conflict"):
        keys.operate(
            "revoke", settings.REMOTE_CONTROL_SIGNING_KID, revision=0, operator="test"
        )
    with patch.object(
        models.RemoteControlSigningEvent.objects,
        "create",
        side_effect=RuntimeError("audit down"),
    ):
        with pytest.raises(RuntimeError, match="audit down"):
            operate("revoke", settings.REMOTE_CONTROL_SIGNING_KID)
    assert keys.public_ring()["generation"] == 1
    assert remote.get_session(m.room.pk, row["id"], m.a)["state"] == "ACTIVE"


@pytest.mark.parametrize(
    "value",
    ["[]", "{}", '{"duplicate":"one","duplicate":"two"}', '{"bad.key":"not a key"}'],
)
def test_invalid_key_configuration_is_not_disclosed(meeting, settings, value):
    settings.REMOTE_CONTROL_SIGNING_KEYS = value
    with pytest.raises(RemoteControlError, match="^signing_unavailable$"):
        keys.configured_keys()
    assert not remote.enabled()


def test_operator_command_prints_public_material_only_and_requires_version(
    meeting, settings
):
    output = io.StringIO()
    call_command("remote_control_keys", "show", stdout=output)
    assert (
        json.loads(output.getvalue())["activeKid"]
        == settings.REMOTE_CONTROL_SIGNING_KID
    )
    assert settings.REMOTE_CONTROL_SIGNING_KEY not in output.getvalue()
    with pytest.raises(CommandError, match="expected-revision"):
        call_command(
            "remote_control_keys",
            "revoke",
            kid=settings.REMOTE_CONTROL_SIGNING_KID,
            operator="test",
            stdout=output,
        )


def test_worker_check_detects_missing_or_mismatched_material(meeting, settings):
    next_key(settings)
    operate("stage")
    output = io.StringIO()
    call_command("remote_control_keys", "check", kid="next-key", stdout=output)
    result = json.loads(output.getvalue())
    assert result["ready"] is True and len(result["fingerprint"]) == 64
    assert "PRIVATE KEY" not in output.getvalue()
    settings.REMOTE_CONTROL_SIGNING_KEYS = ""
    with pytest.raises(CommandError, match="^signing_unavailable$"):
        call_command("remote_control_keys", "check", kid="next-key", stdout=output)


def test_overlap_is_bounded_and_expired_material_is_never_reused(meeting, settings):
    start = timezone.now()
    previous_kid = settings.REMOTE_CONTROL_SIGNING_KID
    previous_pem = settings.REMOTE_CONTROL_SIGNING_KEY
    with patch("core.services.remote_control_keys.timezone.now", return_value=start):
        for index in range(1, 9):
            key, _ = keypair()
            pem = key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            ).decode()
            kid = f"rotation-{index}"
            settings.REMOTE_CONTROL_SIGNING_KEYS = json.dumps(
                {previous_kid: previous_pem, kid: pem}
            )
            operate("stage", kid)
            if index < 8:
                operate("activate", kid)
                previous_kid, previous_pem = kid, pem
            else:
                with pytest.raises(RemoteControlError, match="signing_overlap_limit"):
                    operate("activate", kid)
    assert len(keys.public_ring()["keys"]) == 8
    with patch(
        "core.services.remote_control_keys.timezone.now",
        return_value=start + timedelta(seconds=16),
    ):
        rotated = operate("activate", "rotation-8")
    assert len(rotated["keys"]) == 2 and rotated["generation"] == 1
    assert models.RemoteControlSigningKey.objects.filter(status="expired").count() == 7


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("revoke_first", [True, False])
def test_global_revocation_fences_inflight_approval(meeting, settings, revoke_first):
    m = meeting
    row = prove(m, create(m), "prepare")["session"]
    body, _ = proof(m, row, "approve")
    next_key(settings)
    held, release, connected = Event(), Event(), Event()
    pid = []

    def approve():
        return remote.prove(m.room.pk, row["id"], m.b, "approve", body)

    def revoke():
        return operate(
            "revoke", settings.REMOTE_CONTROL_SIGNING_KID, replacement="next-key"
        )

    def first():
        close_old_connections()
        try:
            with transaction.atomic():
                result = (revoke if revoke_first else approve)()
                held.set()
                assert release.wait(10)
                return result
        finally:
            close_old_connections()

    def second():
        close_old_connections()
        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT pg_backend_pid()")
                pid.append(cursor.fetchone()[0])
            connected.set()
            return (approve if revoke_first else revoke)()
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as executor:
        leading = executor.submit(first)
        try:
            assert held.wait(5)
            trailing = executor.submit(second)
            assert connected.wait(5)
            _blocked(pid[0])
        finally:
            release.set()
        leading.result(timeout=10)
        result = trailing.result(timeout=10)
    assert not models.RemoteControlSession.objects.filter(
        state__in=remote.OPEN
    ).exists()
    if revoke_first:
        assert result["session"]["state"] == "ENDED" and "lease" not in result
    else:
        assert result["endedSessions"] == 1
