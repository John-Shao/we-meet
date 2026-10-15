"""Real PostgreSQL state transitions and API authorization with fake LiveKit IO."""

from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier
from types import SimpleNamespace
from unittest.mock import patch
from uuid import UUID, uuid4

from django.db import close_old_connections
from django.utils import timezone

import jwt
import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from livekit.protocol.models import (
    ParticipantInfo,
    ParticipantPermission,
    TrackInfo,
    TrackSource,
)
from rest_framework.test import APIClient

from core import models
from core.factories import (
    MembershipFactory,
    OrganizationFactory,
    RoomFactory,
    UserFactory,
)
from core.services import remote_control as service
from core.services import remote_control_crypto as crypto
from core.services.remote_control_livekit import RemoteControlError, Snapshot

pytestmark = pytest.mark.django_db


def keypair():
    key = ec.generate_private_key(ec.SECP256R1())
    n = key.public_key().public_numbers()
    return key, {
        "kty": "EC",
        "crv": "P-256",
        "x": crypto.encode64(n.x.to_bytes(32, "big")),
        "y": crypto.encode64(n.y.to_bytes(32, "big")),
    }


def signature(key, body):
    r, s = decode_dss_signature(
        key.sign(crypto.canonical(body), ec.ECDSA(hashes.SHA256()))
    )
    return crypto.encode64(r.to_bytes(32, "big") + s.to_bytes(32, "big"))


def client(user=None):
    result = APIClient()
    if user:
        result.force_authenticate(user)
    return result


@pytest.fixture
def meeting(settings):
    settings.SECRET_KEY = "remote-control-isolated-test-key-only"
    settings.OIDC_OP_JWKS_ENDPOINT = "https://identity.example.test/jwks"
    settings.CACHES = {
        "default": {
            "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
            "LOCATION": str(uuid4()),
        }
    }
    signing, _ = keypair()
    settings.REMOTE_CONTROL_ENABLED = True
    settings.REMOTE_CONTROL_SIGNING_KID = "test-remote-key"
    settings.REMOTE_CONTROL_SIGNING_KEY = signing.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    organization = OrganizationFactory(settings={"remote_control": {"enabled": True}})
    users = [UserFactory() for _ in range(3)]
    for user in users:
        MembershipFactory(user=user, organization=organization, department=None)
    room = RoomFactory(organization=organization)
    people = {}
    devices = {}
    for i, user in enumerate(users):
        people[str(user.sub)] = ParticipantInfo(
            identity=str(user.sub),
            sid=f"PA_{i}",
            state=ParticipantInfo.ACTIVE,
            kind=ParticipantInfo.STANDARD,
            permission=ParticipantPermission(
                can_publish=True,
                can_publish_data=True,
                can_subscribe=True,
                can_publish_sources=[TrackSource.SCREEN_SHARE],
            ),
            tracks=[
                TrackInfo(sid=f"TR_{i}", source=TrackSource.SCREEN_SHARE, muted=False)
            ],
        )
        devices[user.pk] = uuid4()
    evidence = Snapshot("RM_test", people)
    with (
        patch("core.services.remote_control.livekit.snapshot", return_value=evidence),
        patch("core.services.remote_control.livekit.notify"),
    ):
        for user in users:
            service.publish_presence(
                room.pk,
                user,
                {
                    "roomSid": evidence.room_sid,
                    "participantSid": people[str(user.sub)].sid,
                    "deviceSessionId": devices[user.pk],
                    "canControl": True,
                    "canBeControlled": True,
                    "protocolVersions": [1],
                    "platform": "win32",
                    "helperVersion": "1",
                },
            )
        private, public = keypair()
        yield SimpleNamespace(
            room=room,
            a=users[0],
            b=users[1],
            c=users[2],
            people=people,
            evidence=evidence,
            devices=devices,
            private=private,
            public=public,
            signing=signing,
            url=f"/api/v1.0/rooms/{room.pk}/remote-control/",
        )


def request_data(m, a=None, b=None):
    a, b = a or m.a, b or m.b
    return {
        "requestId": uuid4(),
        "roomSid": "RM_test",
        "controllerSid": m.people[str(a.sub)].sid,
        "targetSid": m.people[str(b.sub)].sid,
        "targetUserId": b.pk,
        "controllerPublicKey": m.public,
    }


def create(m):
    response = client(m.a).post(m.url + "requests/", request_data(m), format="json")
    assert response.status_code == 200, response.data
    return response.data


def proof(m, row, purpose):
    body = {"purpose": purpose, "stateVersion": row["stateVersion"]}
    if purpose == "prepare":
        body["binding"] = {
            "targetPublicKey": m.public,
            "shareInstanceId": str(uuid4()),
            "trackSid": "TR_1",
            "displayBindingHash": "a" * 64,
            "targetDeviceSessionId": str(m.devices[m.b.pk]),
        }
    response = client(m.b).post(
        m.url + row["id"] + "/authorization-challenge/", body, format="json"
    )
    assert response.status_code == 200, response.data
    payload = response.data["proof"]
    return {
        "challengeId": payload["challengeId"],
        "signature": signature(m.private, payload),
    }, payload


def prove(m, row, purpose):
    data, _ = proof(m, row, purpose)
    response = client(m.b).post(m.url + row["id"] + f"/{purpose}/", data, format="json")
    assert response.status_code == 200, response.data
    return response.data


def active(m):
    row = create(m)
    row = prove(m, row, "prepare")["session"]
    return prove(m, row, "approve")


def test_capabilities_provide_only_current_accounts_eligible_screen_tracks(meeting):
    m = meeting
    own = m.people[str(m.b.sub)]
    own.tracks.extend(
        [
            TrackInfo(sid="TR_camera", source=TrackSource.CAMERA),
            TrackInfo(sid="TR_muted", source=TrackSource.SCREEN_SHARE, muted=True),
        ]
    )
    response = client(m.b).get(m.url + "capabilities/")
    assert response.status_code == 200
    assert response.data["self"] == {
        "identity": str(m.b.sub),
        "participantSid": "PA_1",
        "screenTrackSids": ["TR_1"],
    }
    own.permission.can_publish = False
    response = client(m.b).get(m.url + "capabilities/")
    assert response.status_code == 200
    assert response.data["self"]["screenTrackSids"] == []


def test_signed_lifecycle_pause_resume_and_terminal_replay(meeting):
    m = meeting
    result = active(m)
    row = result["session"]
    claims = jwt.decode(
        result["lease"],
        m.signing.public_key(),
        algorithms=["ES256"],
        audience=crypto.AUDIENCE,
    )
    assert claims["exp"] - claims["iat"] <= 15
    assert claims["binding"]["targetSid"] == "PA_1"
    assert claims["binding"]["scope"] == ["pointer", "keyboard", "text"]
    paused = (
        client(m.b)
        .post(
            m.url + row["id"] + "/pause/",
            {"stateVersion": row["stateVersion"]},
            format="json",
        )
        .data
    )
    assert paused["state"] == "PAUSED"
    renewed = prove(m, paused, "lease")["session"]
    assert renewed["state"] == "PAUSED"
    resumed = prove(m, renewed, "resume")["session"]
    assert resumed["epoch"] == 2 and resumed["state"] == "ACTIVE"
    data, _ = proof(m, resumed, "lease")
    ended = client(m.b).post(
        m.url + row["id"] + "/end/",
        {"stateVersion": resumed["stateVersion"]},
        format="json",
    )
    assert ended.data["state"] == "ENDED"
    late = client(m.b).post(m.url + row["id"] + "/lease/", data, format="json")
    assert late.data["session"]["state"] == "ENDED" and "lease" not in late.data
    events = list(
        models.RemoteControlAudit.objects.filter(session_id=row["id"]).values_list(
            "event", flat=True
        )
    )
    assert events == ["requested", "prepare", "approve", "paused", "resume", "ended"]


def test_request_idempotency_and_immutable_controller_key(meeting):
    m = meeting
    data = request_data(m)
    a = service.create_request(m.room.pk, m.a, data)
    assert service.create_request(m.room.pk, m.a, data)["id"] == a["id"]
    data["controllerPublicKey"] = keypair()[1]
    with pytest.raises(RemoteControlError, match="idempotency_conflict"):
        service.create_request(m.room.pk, m.a, data)
    assert models.RemoteControlSession.objects.count() == 1


@pytest.mark.parametrize("actor", ["a", "c"])
def test_only_target_may_prepare_approve_or_renew(meeting, actor):
    m = meeting
    row = create(m)
    body, _ = proof(m, row, "prepare")
    response = client(getattr(m, actor)).post(
        m.url + row["id"] + "/prepare/", body, format="json"
    )
    assert response.status_code == 404
    assert models.RemoteControlSession.objects.get(pk=row["id"]).state == "PENDING"


@pytest.mark.parametrize(
    "change",
    [
        "signature",
        "purpose",
        "expiry",
        "version",
        "track",
        "sid",
        "room",
        "permission",
        "disabled",
    ],
)
def test_proof_fails_closed_on_changed_evidence(meeting, settings, change):
    m = meeting
    row = create(m)
    data, payload = proof(m, row, "prepare")
    endpoint = "prepare"
    if change == "signature":
        data["signature"] = signature(keypair()[0], payload)
    elif change == "purpose":
        endpoint = "approve"
    elif change == "expiry":
        models.RemoteControlChallenge.objects.filter(pk=data["challengeId"]).update(
            expires_at=timezone.now() - timedelta(seconds=1)
        )
    elif change == "version":
        models.RemoteControlSession.objects.filter(pk=row["id"]).update(state_version=2)
    elif change == "track":
        m.people[str(m.b.sub)].tracks[0].muted = True
    elif change == "sid":
        m.people[str(m.b.sub)].sid = "PA_replaced"
    elif change == "room":
        object.__setattr__(m.evidence, "room_sid", "RM_replaced")
    elif change == "permission":
        m.people[str(m.b.sub)].permission.can_publish_data = False
    else:
        settings.REMOTE_CONTROL_ENABLED = False
    response = client(m.b).post(
        m.url + row["id"] + f"/{endpoint}/", data, format="json"
    )
    assert response.status_code in (400, 403, 409)
    assert models.RemoteControlSession.objects.get(pk=row["id"]).state == "PENDING"


def test_expired_lease_cannot_be_renewed(meeting):
    m = meeting
    row = active(m)["session"]
    data, _ = proof(m, row, "lease")
    models.RemoteControlSession.objects.filter(pk=row["id"]).update(
        deadline=timezone.now() - timedelta(seconds=1)
    )
    response = client(m.b).post(m.url + row["id"] + "/lease/", data, format="json")
    assert response.data["session"]["state"] == "EXPIRED"
    assert "lease" not in response.data


def test_consumed_challenge_replay_returns_receipt_without_extending_lease(meeting):
    m = meeting
    row = prove(m, create(m), "prepare")["session"]
    data, _ = proof(m, row, "approve")
    first = client(m.b).post(m.url + row["id"] + "/approve/", data, format="json")
    later = timezone.now() + timedelta(seconds=2)
    with patch("core.api.remote_control.timezone.now", return_value=later):
        again = client(m.b).post(m.url + row["id"] + "/approve/", data, format="json")
    assert first.data["session"] == again.data["session"]
    assert first.data["lease"] == again.data["lease"]
    assert again.data["serverTime"] >= first.data["serverTime"] + 1
    assert models.RemoteControlAudit.objects.filter(event="approve").count() == 1


@pytest.mark.parametrize("kind", ["anonymous", "device", "inactive", "foreign"])
def test_invalid_accounts_and_third_party_cannot_read_session(meeting, kind):
    m = meeting
    row = create(m)
    user = None if kind == "anonymous" else m.c
    if kind == "device":
        user.is_device = True
    if kind == "inactive":
        user.is_active = False
    response = client(user).get(m.url + row["id"] + "/")
    assert response.status_code in (401, 403, 404)
    assert "requestDigest" not in response.data


def test_org_admin_can_revoke_but_cannot_approve(meeting):
    m = meeting
    row = active(m)["session"]
    models.Membership.objects.filter(user=m.c).update(
        org_role=models.OrgRoleChoices.ADMIN
    )
    invalid = client(m.c).post(
        m.url + row["id"] + "/authorization-challenge/",
        {"purpose": "lease", "stateVersion": row["stateVersion"]},
        format="json",
    )
    assert invalid.status_code == 404
    revoked = client(m.c).post(
        m.url + row["id"] + "/end/",
        {"stateVersion": row["stateVersion"]},
        format="json",
    )
    assert revoked.status_code == 200 and revoked.data["state"] == "ENDED"


def test_webhook_cleanup_matches_room_instance_connection_and_track(meeting):
    m = meeting
    row = active(m)["session"]
    service.invalidate(m.room.pk, "RM_old", participant_sid="PA_1")
    service.invalidate(m.room.pk, "RM_test", track_sid="TR_other")
    assert models.RemoteControlSession.objects.get(pk=row["id"]).state == "ACTIVE"
    service.invalidate(
        m.room.pk,
        "RM_test",
        participant_sid="PA_1",
        track_sid="TR_1",
        reason="share_stopped",
    )
    assert models.RemoteControlSession.objects.get(pk=row["id"]).state == "ENDED"


def test_disabled_peer_does_not_prevent_local_stop(meeting):
    m = meeting
    row = active(m)["session"]
    models.User.objects.filter(pk=m.a.pk).update(is_active=False)
    result = client(m.b).post(
        m.url + row["id"] + "/end/",
        {"stateVersion": row["stateVersion"]},
        format="json",
    )
    assert result.status_code == 200 and result.data["state"] == "ENDED"


@pytest.mark.django_db(transaction=True)
def test_inverse_concurrent_requests_cannot_form_cycle(meeting):
    m = meeting
    barrier = Barrier(2)

    def attempt(a, b):
        close_old_connections()
        try:
            barrier.wait(timeout=5)
            try:
                service.create_request(m.room.pk, a, request_data(m, a, b))
                return "created"
            except RemoteControlError as exc:
                return exc.code
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as executor:
        a = executor.submit(attempt, m.a, m.b)
        b = executor.submit(attempt, m.b, m.a)
        assert sorted([a.result(timeout=15), b.result(timeout=15)]) == [
            "busy",
            "created",
        ]
    assert (
        models.RemoteControlSession.objects.filter(state__in=service.OPEN).count() == 1
    )
