"""API tests for the calendar / scheduling endpoints (P2)."""

from datetime import timedelta

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from core import factories, models

pytestmark = pytest.mark.django_db


def _membership(org, user, **kwargs):
    return models.Membership.objects.create(
        organization=org, user=user, is_primary=True, **kwargs
    )


def _times():
    start = timezone.now() + timedelta(days=1)
    return start, start + timedelta(hours=1)


def test_calendar_requires_authentication():
    assert APIClient().get("/api/v1.0/calendar-events/").status_code == 401


def test_create_event_provisions_room_and_attendees():
    org = factories.OrganizationFactory()
    me = factories.UserFactory(full_name="Organizer", email="org@acme.com")
    _membership(org, me)
    peer = factories.UserFactory(full_name="Peer", email="peer@acme.com")
    _membership(org, peer)
    start, end = _times()

    client = APIClient()
    client.force_login(me)
    resp = client.post(
        "/api/v1.0/calendar-events/",
        {
            "title": "Sprint planning",
            "start_at": start.isoformat(),
            "end_at": end.isoformat(),
            "attendee_ids": [str(peer.id)],
        },
        format="json",
    )
    assert resp.status_code == 201, resp.content
    event = models.CalendarEvent.objects.get(id=resp.json()["id"])

    assert event.organizer == me
    assert event.organization == org
    # Room provisioned with scheduled_at = start.
    assert event.room is not None
    assert event.room.scheduled_at == start
    # Organizer + invitee attendees.
    assert event.attendees.filter(
        user=me,
        role=models.EventAttendeeRoleChoices.ORGANIZER,
        rsvp=models.EventRSVPChoices.ACCEPTED,
    ).exists()
    assert event.attendees.filter(
        user=peer, role=models.EventAttendeeRoleChoices.REQUIRED
    ).exists()
    # Room access: organizer owner + invitee member (so the IM group includes them).
    assert event.room.accesses.filter(
        user=me, role=models.RoleChoices.OWNER
    ).exists()
    assert event.room.accesses.filter(
        user=peer, role=models.RoleChoices.MEMBER
    ).exists()


def test_list_scoped_to_org_and_visibility():
    org = factories.OrganizationFactory()
    organizer = factories.UserFactory(email="o@acme.com")
    _membership(org, organizer)
    invitee = factories.UserFactory(email="i@acme.com")
    _membership(org, invitee)
    outsider = factories.UserFactory(email="x@acme.com")  # same org, not invited
    _membership(org, outsider)
    start, end = _times()

    event = models.CalendarEvent.objects.create(
        organization=org, organizer=organizer, title="Standup",
        start_at=start, end_at=end,
    )
    models.EventAttendee.objects.create(
        event=event, user=organizer,
        role=models.EventAttendeeRoleChoices.ORGANIZER,
    )
    models.EventAttendee.objects.create(event=event, user=invitee)

    # Invitee sees it.
    c = APIClient()
    c.force_login(invitee)
    ids = {e["id"] for e in c.get("/api/v1.0/calendar-events/").json()["results"]}
    assert str(event.id) in ids
    # A same-org non-attendee does not.
    c2 = APIClient()
    c2.force_login(outsider)
    ids2 = {e["id"] for e in c2.get("/api/v1.0/calendar-events/").json()["results"]}
    assert str(event.id) not in ids2


def test_rsvp_updates_attendee_and_rejects_bad_status():
    org = factories.OrganizationFactory()
    organizer = factories.UserFactory(email="o@acme.com")
    _membership(org, organizer)
    invitee = factories.UserFactory(email="i@acme.com")
    _membership(org, invitee)
    start, end = _times()
    event = models.CalendarEvent.objects.create(
        organization=org, organizer=organizer, title="Review",
        start_at=start, end_at=end,
    )
    models.EventAttendee.objects.create(
        event=event, user=organizer,
        role=models.EventAttendeeRoleChoices.ORGANIZER,
    )
    att = models.EventAttendee.objects.create(event=event, user=invitee)

    client = APIClient()
    client.force_login(invitee)
    ok = client.post(
        f"/api/v1.0/calendar-events/{event.id}/rsvp/",
        {"status": "accepted"},
        format="json",
    )
    assert ok.status_code == 200, ok.content
    att.refresh_from_db()
    assert att.rsvp == models.EventRSVPChoices.ACCEPTED

    bad = client.post(
        f"/api/v1.0/calendar-events/{event.id}/rsvp/",
        {"status": "maybe-later"},
        format="json",
    )
    assert bad.status_code == 400
