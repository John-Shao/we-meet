"""Real PostgreSQL policy updates, authorization boundaries and lock races."""

from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Event
from time import monotonic, sleep
from unittest.mock import patch
from uuid import uuid4

from django.db import close_old_connections, connection, transaction
from django.utils import timezone

import pytest

from core import models
from core.factories import MembershipFactory, OrganizationFactory, UserFactory
from core.services import remote_control as remote
from core.services import remote_control_admin as admin
from core.services import remote_control_policy as policies
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
URL = "/api/v1.0/admin/remote-control/"


def administrator(m):
    models.Membership.objects.filter(user=m.c).update(
        org_role=models.OrgRoleChoices.ADMIN
    )
    return client(m.c)


def update(c, **changes):
    current = c.get(URL + "policy/")
    assert current.status_code == 200, current.data
    return c.put(
        URL + "policy/",
        {
            "version": current.data["version"],
            "policy": {**current.data["policy"], **changes},
        },
        format="json",
    )


def test_default_off_and_strict_admin_scope(meeting, settings):
    m = meeting
    for operation in ("policy", "members"):
        assert client(m.a).get(URL + operation + "/").status_code == 403
    other = OrganizationFactory()
    MembershipFactory(
        user=m.a,
        organization=other,
        org_role=models.OrgRoleChoices.OWNER,
        is_primary=False,
    )
    assert (
        client(m.a).post(URL + "emergency-close/", {}, format="json").status_code == 403
    )
    c = administrator(m)
    m.room.organization.settings = {"unrelated": {"keep": True}}
    m.room.organization.save()
    settings.REMOTE_CONTROL_ENABLED = False
    response = c.get(URL + "policy/")
    assert response.status_code == 200
    assert response.data["policy"] == policies.DEFAULTS
    assert response.data["globalEnabled"] is False
    assert response["Cache-Control"] == "private, no-store"
    assert update(c, enabled=True).status_code == 200
    m.room.organization.refresh_from_db()
    assert m.room.organization.settings["unrelated"] == {"keep": True}


@pytest.mark.parametrize(
    "field,value",
    [
        ("enabled", "true"),
        ("max_seconds", True),
        ("max_seconds", 1801),
        ("requests_per_minute", 0),
        ("requests_per_minute", "3"),
        ("rejection_cooldown_seconds", 601),
        ("controllers", "all"),
        ("controllers", ["bad"]),
        ("targets", [str(uuid4())] * 65),
        ("unexpected", True),
    ],
)
def test_invalid_policy_never_mutates(meeting, field, value):
    c = administrator(meeting)
    before = c.get(URL + "policy/").data["version"]
    assert update(c, **{field: value}).status_code == 400
    assert c.get(URL + "policy/").data["version"] == before
    assert not models.AuditLog.objects.exists()


def test_allowlists_are_active_human_org_members_and_intersect_room(meeting):
    m = meeting
    c = administrator(m)
    outsider = UserFactory()
    assert update(c, controllers=[str(outsider.pk)]).status_code == 400
    assert update(c, controllers=[str(m.a.pk)] * 2).status_code == 400
    assert (
        update(c, controllers=[str(m.a.pk)], targets=[str(m.b.pk)]).status_code == 200
    )
    candidates = c.get(URL + "members/")
    assert {item["id"] for item in candidates.data["results"]} == {
        str(m.a.pk),
        str(m.b.pk),
        str(m.c.pk),
    }
    m.room.configuration = {"remote_control": {"controllers": [str(m.c.pk)]}}
    m.room.save()
    response = client(m.a).post(m.url + "requests/", request_data(m), format="json")
    assert response.status_code == 403
    assert response.data["code"] == "remote_control_not_allowed"
    m.room.configuration = {"remote_control": {"enabled": True}}
    m.room.save()
    assert update(c, targets=[]).status_code == 200
    assert (
        client(m.a)
        .post(m.url + "requests/", request_data(m), format="json")
        .status_code
        == 403
    )


def test_version_conflict_and_emergency_ignore_stale_editor(meeting):
    m = meeting
    row = active(m)["session"]
    c = administrator(m)
    old = c.get(URL + "policy/").data
    response = update(c, max_seconds=300)
    assert response.status_code == 200 and response.data["revokedSessions"] == 1
    stale = c.put(
        URL + "policy/",
        {"version": old["version"], "policy": old["policy"]},
        format="json",
    )
    assert stale.status_code == 409
    closed = c.post(URL + "emergency-close/", {}, format="json")
    assert closed.status_code == 200 and closed.data["policy"]["enabled"] is False
    state = client(m.a).get(m.url + row["id"] + "/").data
    assert state["state"] == "ENDED" and "lease" not in state
    events = list(models.AuditLog.objects.values_list("metadata", flat=True))
    assert len(events) == 2
    assert all(set(event) == {"before", "after", "revokedSessions"} for event in events)


def test_emergency_close_revokes_consumed_receipt_and_unconsumed_challenge(meeting):
    m = meeting
    row = prove(m, create(m), "prepare")["session"]
    data, _ = proof(m, row, "approve")
    response = client(m.b).post(m.url + row["id"] + "/approve/", data, format="json")
    assert "lease" in response.data
    lease_data, _ = proof(m, response.data["session"], "lease")
    administrator(m).post(URL + "emergency-close/", {}, format="json")
    for purpose, body in (("approve", data), ("lease", lease_data)):
        reply = client(m.b).post(
            m.url + row["id"] + f"/{purpose}/", body, format="json"
        )
        assert reply.status_code == 200
        assert reply.data["session"]["state"] == "ENDED" and "lease" not in reply.data


def test_audit_failure_rolls_back_policy_and_revocations(meeting):
    m = meeting
    row = active(m)["session"]
    administrator(m)
    with patch.object(
        models.AuditLog.objects, "create", side_effect=RuntimeError("audit down")
    ):
        with pytest.raises(RuntimeError, match="audit down"):
            admin.update_policy(m.c, emergency=True)
    assert remote.get_session(m.room.pk, row["id"], m.a)["state"] == "ACTIVE"
    assert admin.read_policy(m.c)["policy"]["enabled"] is True


def test_invalid_stored_policy_fails_closed_and_can_be_repaired(meeting):
    m = meeting
    c = administrator(m)
    m.room.organization.settings = {"remote_control": {"enabled": True, "extra": "bad"}}
    m.room.organization.save()
    assert c.get(URL + "policy/").data["valid"] is False
    response = client(m.a).post(m.url + "requests/", request_data(m), format="json")
    assert response.status_code == 503
    assert c.post(URL + "emergency-close/", {}, format="json").data["valid"] is True


def test_configurable_rate_and_longer_rejection_cooldown(meeting):
    m = meeting
    c = administrator(m)
    assert (
        update(c, requests_per_minute=1, rejection_cooldown_seconds=180).status_code
        == 200
    )
    row = create(m)
    remote.action(m.room.pk, row["id"], m.a, "cancel", row["stateVersion"])
    assert (
        client(m.a)
        .post(m.url + "requests/", request_data(m), format="json")
        .status_code
        == 429
    )
    models.RemoteControlSession.objects.filter(pk=row["id"]).update(
        state="REJECTED",
        created_at=timezone.now() - timedelta(seconds=150),
        ended_at=timezone.now() - timedelta(seconds=120),
    )
    assert (
        client(m.a)
        .post(m.url + "requests/", request_data(m), format="json")
        .status_code
        == 429
    )
    models.RemoteControlSession.objects.filter(pk=row["id"]).update(
        ended_at=timezone.now() - timedelta(seconds=181)
    )
    assert (
        client(m.a)
        .post(m.url + "requests/", request_data(m), format="json")
        .status_code
        == 200
    )


def test_room_cannot_loosen_rate_or_cooldown(meeting):
    m = meeting
    c = administrator(m)
    assert (
        update(c, requests_per_minute=1, rejection_cooldown_seconds=180).status_code
        == 200
    )
    m.room.configuration = {
        "remote_control": {"requests_per_minute": 10, "rejection_cooldown_seconds": 1}
    }
    m.room.save()
    row = create(m)
    remote.action(m.room.pk, row["id"], m.a, "cancel", row["stateVersion"])
    assert (
        client(m.a)
        .post(m.url + "requests/", request_data(m), format="json")
        .status_code
        == 429
    )


def test_full_policy_lists_fit_digest_and_order_is_irrelevant():
    ids = [str(uuid4()) for _ in range(64)]
    organization = policies.normalize(
        {"enabled": True, "controllers": ids, "targets": ids}
    )
    room = policies.normalize(
        {"controllers": list(reversed(ids)), "targets": ids}, room=True
    )
    assert len(policies.digest(organization, room)) == 64
    assert organization["controllers"] == room["controllers"]


def test_unsupported_database_cannot_silently_skip_policy_lock(meeting):
    with patch.object(connection, "vendor", "sqlite"):
        with pytest.raises(RemoteControlError, match="policy_locking_unavailable"):
            policies.share_organization(meeting.room.organization_id)


def test_admin_cache_cannot_survive_role_removal(meeting):
    m = meeting
    c = administrator(m)
    m.c._org_admin_cache = True
    assert c.get(URL + "policy/").status_code == 200
    models.Membership.objects.filter(user=m.c).update(
        org_role=models.OrgRoleChoices.MEMBER
    )
    assert c.post(URL + "emergency-close/", {}, format="json").status_code == 403


def test_candidate_pagination_and_ineligible_member_rejection(meeting):
    m = meeting
    c = administrator(m)
    for _ in range(49):
        MembershipFactory(organization=m.room.organization, department=None)
    first = c.get(URL + "members/").data
    second = c.get(URL + "members/", {"after": first["next_cursor"]}).data
    ids = [person["id"] for person in first["results"] + second["results"]]
    assert len(ids) == len(set(ids)) == 52
    assert len(first["results"]) == 50 and second["next_cursor"] is None
    models.Membership.objects.filter(user=m.b).update(
        status=models.MembershipStatusChoices.SUSPENDED
    )
    assert update(c, targets=[str(m.b.pk)]).status_code == 400
    assert str(m.b.pk) not in {
        person["id"]
        for person in c.get(URL + "members/", {"q": m.b.full_name}).data["results"]
    }


def _blocked(pid):
    deadline = monotonic() + 5
    while monotonic() < deadline:
        with connection.cursor() as cursor:
            cursor.execute("SELECT cardinality(pg_blocking_pids(%s))", [pid])
            if cursor.fetchone()[0]:
                return
        sleep(0.01)
    pytest.fail("Competing transaction did not wait on PostgreSQL policy lock")


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("operation", ["request", "admin"])
def test_existing_account_then_org_lock_order_is_preserved(meeting, operation):
    """Voiceprint governance already locks its actor before the organization."""
    m = meeting
    administrator(m)
    actor = m.a if operation == "request" else m.c
    held, release, connected = Event(), Event(), Event()
    waiter_pid = []

    def existing_governance():
        close_old_connections()
        try:
            with transaction.atomic():
                models.User.objects.select_for_update().get(pk=actor.pk)
                held.set()
                assert release.wait(10)
                models.Organization.objects.select_for_update().get(
                    pk=m.room.organization_id
                )
        finally:
            close_old_connections()

    def remote_operation():
        close_old_connections()
        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT pg_backend_pid()")
                waiter_pid.append(cursor.fetchone()[0])
            connected.set()
            if operation == "request":
                return remote.create_request(m.room.pk, m.a, request_data(m))
            return admin.update_policy(m.c, emergency=True)
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as executor:
        leading = executor.submit(existing_governance)
        try:
            assert held.wait(5)
            trailing = executor.submit(remote_operation)
            assert connected.wait(5)
            _blocked(waiter_pid[0])
            # A remote operation waiting on the account must not already hold
            # the organization: that would deadlock the existing governance.
            with transaction.atomic():
                models.Organization.objects.select_for_update(nowait=True).get(
                    pk=m.room.organization_id
                )
        finally:
            release.set()
        leading.result(timeout=10)
        trailing.result(timeout=10)


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("operation", ["create", "approve"])
@pytest.mark.parametrize("close_first", [True, False])
def test_close_vs_grant_is_serialized(meeting, operation, close_first):  # noqa: PLR0915 -- Both PostgreSQL commit orders, with explicit worker cleanup.
    m = meeting
    administrator(m)
    if operation == "approve":
        row = prove(m, create(m), "prepare")["session"]
        data, _ = proof(m, row, "approve")

    def grant():
        try:
            if operation == "create":
                return remote.create_request(m.room.pk, m.a, request_data(m))
            return remote.prove(m.room.pk, row["id"], m.b, "approve", data)
        except RemoteControlError as exc:
            return {"code": exc.code}

    def close():
        return admin.update_policy(m.c, emergency=True)

    held, release, connected = Event(), Event(), Event()
    waiter_pid = []

    def first():
        close_old_connections()
        try:
            with transaction.atomic():
                result = (close if close_first else grant)()
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
                waiter_pid.append(cursor.fetchone()[0])
            connected.set()
            return (grant if close_first else close)()
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as executor:
        leading = executor.submit(first)
        try:
            assert held.wait(5)
            trailing = executor.submit(second)
            assert connected.wait(5)
            _blocked(waiter_pid[0])
        finally:
            release.set()
        leading.result(timeout=10)
        result = trailing.result(timeout=10)
    assert not models.RemoteControlSession.objects.filter(
        state__in=remote.OPEN
    ).exists()
    if close_first:
        assert "lease" not in result
        if operation == "create":
            assert result["code"] == "remote_control_disabled"
        else:
            assert result["session"]["state"] == "ENDED"
    else:
        assert result["revokedSessions"] == 1
