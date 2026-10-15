"""Retained lifecycle history, bounded admin pages and room deletion revocation."""

from datetime import timedelta
from uuid import uuid4

from django.core.exceptions import ImproperlyConfigured
from django.utils import timezone

import pytest

from core import models
from core.factories import MembershipFactory, OrganizationFactory, UserFactory
from core.services import remote_control as service
from core.tests.services.test_remote_control import active, client, create, meeting

pytestmark = pytest.mark.django_db


def administrator(meeting):
    models.Membership.objects.filter(user=meeting.c).update(
        org_role=models.OrgRoleChoices.ADMIN
    )
    return client(meeting.c)


def test_room_queryset_delete_ends_control_and_retains_admin_history(meeting):
    m = meeting
    row = active(m)["session"]
    room_id = m.room.pk
    admin = administrator(m)
    models.Room.objects.filter(pk=room_id).delete()
    retained = models.RemoteControlSession.objects.get(pk=row["id"])
    assert retained.room_id is None
    assert retained.room_reference == room_id
    assert retained.state == "ENDED"
    assert retained.end_reason == "room_deleted"
    assert retained.lease_expires_at <= timezone.now()
    url = m.url + row["id"] + "/audit/"
    response = admin.get(url)
    assert response.status_code == 200
    assert response.data["session"]["roomId"] == str(room_id)
    assert response.data["session"]["targetDeviceSessionId"] == str(m.devices[m.b.pk])
    assert response.data["events"][-1]["reason"] == "room_deleted"
    assert client(m.a).get(url).status_code == 403
    assert client(m.b).get(m.url + row["id"] + "/").status_code == 404


def test_audit_keyset_pages_cover_same_timestamp_records_without_truncation(meeting):
    m = meeting
    row = create(m)
    session = models.RemoteControlSession.objects.get(pk=row["id"])
    models.RemoteControlAudit.objects.bulk_create(
        [
            models.RemoteControlAudit(
                session=session,
                event="paused",
                state="PAUSED",
                state_version=index + 2,
            )
            for index in range(260)
        ]
    )
    session.audit.update(created_at=timezone.now())
    admin, cursor, seen = administrator(m), None, []
    for _ in range(5):
        response = admin.get(
            m.url + row["id"] + "/audit/",
            {"limit": 100, **({"after": cursor} if cursor else {})},
        )
        assert response.status_code == 200
        assert len(response.data["events"]) <= 100
        seen.extend(event["id"] for event in response.data["events"])
        cursor = response.data["nextCursor"]
        if cursor is None:
            break
    assert len(seen) == len(set(seen)) == 261
    assert cursor is None
    assert set(seen) == set(session.audit.values_list("id", flat=True))


def test_audit_rejects_foreign_admin_cursor_and_unbounded_query(meeting):
    m = meeting
    row = create(m)
    url = m.url + row["id"] + "/audit/"
    outsider = UserFactory()
    MembershipFactory(
        user=outsider,
        organization=OrganizationFactory(),
        org_role=models.OrgRoleChoices.ADMIN,
        department=None,
    )
    assert client(outsider).get(url).status_code == 403
    admin = administrator(m)
    for query in (
        {"after": str(uuid4())},
        {"after": "bad-cursor"},
        {"limit": 0},
        {"limit": 201},
        {"limit": "1.5"},
        {"includeInput": "true"},
    ):
        assert admin.get(url, query).status_code == 400
    models.Membership.objects.filter(user=m.c).update(
        status=models.MembershipStatusChoices.SUSPENDED
    )
    assert admin.get(url).status_code == 403


def test_configured_retention_deletes_only_old_terminal_sessions(meeting, settings):
    m = meeting
    ended = create(m)
    service.action(m.room.pk, ended["id"], m.a, "end", ended["stateVersion"])
    models.RemoteControlSession.objects.filter(pk=ended["id"]).update(
        ended_at=timezone.now() - timedelta(days=31)
    )
    opened = create(m)
    models.RemoteControlSession.objects.filter(pk=opened["id"]).update(
        ended_at=timezone.now() - timedelta(days=100)
    )
    settings.REMOTE_CONTROL_AUDIT_RETENTION_DAYS = 90
    service.prune_history()
    assert models.RemoteControlSession.objects.filter(pk=ended["id"]).exists()
    settings.REMOTE_CONTROL_AUDIT_RETENTION_DAYS = 30
    service.prune_history()
    assert not models.RemoteControlSession.objects.filter(pk=ended["id"]).exists()
    assert not models.RemoteControlAudit.objects.filter(session_id=ended["id"]).exists()
    assert models.RemoteControlSession.objects.filter(pk=opened["id"]).exists()
    assert models.RemoteControlAudit.objects.filter(session_id=opened["id"]).exists()


@pytest.mark.parametrize("days", [0, -1, True, 3651, "90"])
def test_invalid_retention_never_deletes_history(meeting, settings, days):
    row = create(meeting)
    settings.REMOTE_CONTROL_AUDIT_RETENTION_DAYS = days
    with pytest.raises(ImproperlyConfigured):
        service.prune_history()
    assert models.RemoteControlAudit.objects.filter(session_id=row["id"]).exists()
