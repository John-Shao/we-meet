"""Policy, cleanup, audit privacy, and real database race boundaries."""

import json
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier
from types import SimpleNamespace
from uuid import UUID

from django.db import close_old_connections
from django.utils import timezone

import pytest
from livekit.protocol.models import TrackSource
from rest_framework.test import APIClient

from core import models
from core.services import remote_control as service
from core.services.livekit_events import LiveKitEventsService
from core.services.remote_control_livekit import RemoteControlError
from core.tests.services.test_remote_control import (
    active,
    client,
    create,
    meeting,
    proof,
    prove,
    request_data,
)

pytestmark = pytest.mark.django_db


def session_client(user):
    """Exercise real session authentication and its POST-body CSRF parsing."""
    result = APIClient(enforce_csrf_checks=True)
    result.force_login(user, backend="django.contrib.auth.backends.ModelBackend")
    token = "a" * 32
    result.cookies["csrftoken"] = token
    result.credentials(HTTP_X_CSRFTOKEN=token)
    return result


def presence_data(m, user):
    return {
        "roomSid": "RM_test",
        "participantSid": m.people[str(user.sub)].sid,
        "deviceSessionId": str(m.devices[user.pk]),
        "canControl": True,
        "canBeControlled": True,
        "protocolVersions": [1],
        "platform": "win32",
        "helperVersion": "1",
    }


def test_browser_session_can_publish_and_request_with_csrf(meeting):
    m = meeting
    c = session_client(m.a)
    data = {
        **presence_data(m, m.a),
        "canBeControlled": False,
        "platform": "pc-web",
        "helperVersion": "",
    }
    assert c.post(m.url + "capabilities/", data, format="json").status_code == 200
    response = c.post(m.url + "requests/", request_data(m), format="json")
    assert response.status_code == 200
    assert response.data["state"] == "PENDING"
    c.credentials()
    assert c.post(m.url + "capabilities/", data, format="json").status_code == 403


@pytest.mark.parametrize("authenticated_session", [True, False])
@pytest.mark.parametrize("extra_byte", [False, True])
@pytest.mark.parametrize("endpoint", ["presence", "policy", "emergency"])
def test_json_body_byte_limits(meeting, authenticated_session, extra_byte, endpoint):
    m = meeting
    models.Membership.objects.filter(user=m.a).update(
        org_role=models.OrgRoleChoices.ADMIN
    )
    c = session_client(m.a) if authenticated_session else client(m.a)
    if endpoint == "presence":
        url, method, limit = m.url + "capabilities/", c.post, 16384
        data = presence_data(m, m.a)
    elif endpoint == "policy":
        url = "/api/v1.0/admin/remote-control/policy/"
        current = c.get(url).data
        method, limit = c.put, 16384
        data = {"version": current["version"], "policy": current["policy"]}
    else:
        url = "/api/v1.0/admin/remote-control/emergency-close/"
        method, limit, data = c.post, 1024, {}
    payload = json.dumps(data).encode()
    payload += b" " * (limit - len(payload) + int(extra_byte))
    response = method(url, payload, content_type="application/json")
    assert response.status_code == (413 if extra_byte else 200)
    if extra_byte:
        assert response.data["code"] == "request_too_large"


@pytest.mark.parametrize("scope", ["organization", "room", "both"])
def test_native_presence_intersects_independent_role_allowlists(meeting, scope):
    m = meeting
    restriction = {
        "enabled": True,
        "controllers": [str(m.a.pk)],
        "targets": [str(m.b.pk)],
    }
    if scope in ("organization", "both"):
        models.Organization.objects.filter(pk=m.room.organization_id).update(
            settings={"remote_control": restriction}
        )
    if scope in ("room", "both"):
        models.Room.objects.filter(pk=m.room.pk).update(
            configuration={"remote_control": restriction}
        )
    for user, expected in (
        (m.a, (True, False)),
        (m.b, (False, True)),
        (m.c, (False, False)),
    ):
        response = client(user).post(
            m.url + "capabilities/", presence_data(m, user), format="json"
        )
        assert response.status_code == 200
        row = models.RemoteControlPresence.objects.get(room=m.room, user=user)
        assert (row.can_control, row.can_be_controlled) == expected
    assert create(m)["state"] == "PENDING"
    reverse = client(m.b).post(
        m.url + "requests/", request_data(m, m.b, m.a), format="json"
    )
    assert reverse.status_code == 403
    assert reverse.data["code"] == "remote_control_not_allowed"


@pytest.mark.parametrize(
    "restriction",
    [
        "membership",
        "organization",
        "room",
        "target_list",
        "screen_permission",
        "stale_capability",
    ],
)
def test_request_policy_and_presence_restrictions(meeting, restriction):
    m = meeting
    if restriction == "membership":
        models.Membership.objects.filter(user=m.b).update(
            status=models.MembershipStatusChoices.SUSPENDED
        )
    elif restriction == "organization":
        models.Organization.objects.filter(pk=m.room.organization_id).update(
            is_active=False
        )
    elif restriction == "room":
        models.Room.objects.filter(pk=m.room.pk).update(ended_at=timezone.now())
    elif restriction == "target_list":
        models.Organization.objects.filter(pk=m.room.organization_id).update(
            settings={"remote_control": {"enabled": True, "targets": [str(m.c.pk)]}}
        )
    elif restriction == "screen_permission":
        m.people[str(m.b.sub)].permission.can_publish_sources[:] = [TrackSource.CAMERA]
    else:
        models.RemoteControlPresence.objects.filter(user=m.b).update(
            expires_at=timezone.now() - timedelta(seconds=1)
        )
    response = client(m.a).post(m.url + "requests/", request_data(m), format="json")
    assert response.status_code in (403, 409)
    assert not models.RemoteControlSession.objects.exists()


def test_independent_controller_and_target_allowlists(meeting):
    m = meeting
    models.Organization.objects.filter(pk=m.room.organization_id).update(
        settings={
            "remote_control": {
                "enabled": True,
                "controllers": [str(m.a.pk)],
                "targets": [str(m.b.pk)],
            }
        }
    )
    data = {
        "roomSid": "RM_test",
        "participantSid": "PA_0",
        "deviceSessionId": m.devices[m.a.pk],
        "canControl": True,
        "canBeControlled": False,
        "protocolVersions": [1],
        "platform": "pc-web",
        "helperVersion": "",
    }
    response = client(m.a).post(m.url + "capabilities/", data, format="json")
    assert response.status_code == 200
    assert client(m.a).get(m.url + "capabilities/").status_code == 200
    assert create(m)["state"] == "PENDING"


def test_audit_is_admin_only_and_contains_no_proof_or_input(meeting):
    m = meeting
    row = active(m)["session"]
    assert client(m.a).get(m.url + row["id"] + "/audit/").status_code == 403
    models.Membership.objects.filter(user=m.c).update(
        org_role=models.OrgRoleChoices.ADMIN
    )
    response = client(m.c).get(m.url + row["id"] + "/audit/")
    assert response.status_code == 200
    assert set(response.data["events"][0]) == {
        "id",
        "actor_id",
        "event",
        "state",
        "state_version",
        "reason",
        "created_at",
    }


def test_pause_retry_does_not_reopen_or_extend_lease(meeting):
    m = meeting
    row = active(m)["session"]
    url = m.url + row["id"] + "/pause/"
    first = client(m.b).post(url, {"stateVersion": row["stateVersion"]}, format="json")
    again = client(m.b).post(url, {"stateVersion": row["stateVersion"]}, format="json")
    assert first.data["stateVersion"] == again.data["stateVersion"]
    assert first.data["deadline"] == again.data["deadline"]
    assert again.data["state"] == "PAUSED"


def test_verified_webhook_dispatch_reclaims_exact_instance(meeting):
    m = meeting
    row = active(m)["session"]
    event = SimpleNamespace(
        event="participant_left",
        room=SimpleNamespace(name=str(m.room.pk), sid="RM_test"),
        participant=SimpleNamespace(sid="PA_1"),
    )
    LiveKitEventsService._revoke_remote_control(event)
    assert (
        models.RemoteControlSession.objects.get(pk=row["id"]).end_reason
        == "participant_left"
    )


@pytest.mark.django_db(transaction=True)
def test_approve_cancel_race_has_one_terminal_decision(meeting):
    m = meeting
    row = prove(m, create(m), "prepare")["session"]
    body, _ = proof(m, row, "approve")
    body["challengeId"] = UUID(body["challengeId"])
    barrier = Barrier(2)

    def attempt(approve):
        close_old_connections()
        try:
            barrier.wait(timeout=5)
            if approve:
                return service.prove(m.room.pk, UUID(row["id"]), m.b, "approve", body)[
                    "session"
                ]["state"]
            try:
                return service.action(
                    m.room.pk, UUID(row["id"]), m.a, "cancel", row["stateVersion"]
                )["state"]
            except RemoteControlError as exc:
                return exc.code
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as executor:
        a, b = executor.submit(attempt, True), executor.submit(attempt, False)
        outcomes = [a.result(timeout=15), b.result(timeout=15)]
    state = models.RemoteControlSession.objects.get(pk=row["id"]).state
    assert state in ("ACTIVE", "CANCELLED")
    assert outcomes in (["ACTIVE", "state_conflict"], ["CANCELLED", "CANCELLED"])
    assert (
        models.RemoteControlAudit.objects.filter(
            session_id=row["id"], event__in=("approve", "ended")
        ).count()
        == 1
    )
