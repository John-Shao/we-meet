"""Organizer-transfer contract for single and recurring calendar events."""

from datetime import timedelta
from unittest.mock import patch

from django.utils import timezone

import pytest
from rest_framework.test import APIClient

from core import factories, models

pytestmark = pytest.mark.django_db


def _membership(organization, user, *, status=models.MembershipStatusChoices.ACTIVE):
    return models.Membership.objects.create(
        organization=organization,
        user=user,
        is_primary=True,
        status=status,
    )


def _client(user):
    client = APIClient()
    client.force_login(user)
    return client


def _event(organization, organizer, *, recurrence="", source_cid="source-cid"):
    start = timezone.now() + timedelta(days=2)
    room = models.Room.objects.create(name="Transfer room", scheduled_at=start)
    event = models.CalendarEvent.objects.create(
        organization=organization,
        organizer=organizer,
        title="Design review",
        start_at=start,
        end_at=start + timedelta(hours=1),
        recurrence=recurrence,
        source_conversation_id=source_cid,
        room=room,
    )
    models.EventAttendee.objects.create(
        event=event,
        user=organizer,
        role=models.EventAttendeeRoleChoices.ORGANIZER,
        rsvp=models.EventRSVPChoices.ACCEPTED,
    )
    models.ResourceAccess.objects.create(
        resource=room, user=organizer, role=models.RoleChoices.OWNER
    )
    return event


def test_transfer_moves_organizer_calendar_room_access_and_notifies(
    django_capture_on_commit_callbacks,
):
    organization = factories.OrganizationFactory()
    old = factories.UserFactory(full_name="Old organizer")
    new = factories.UserFactory(full_name="New organizer")
    attendee = factories.UserFactory(full_name="Attendee")
    for user in (old, new, attendee):
        _membership(organization, user)
    event = _event(organization, old)
    models.EventAttendee.objects.create(event=event, user=attendee)
    models.ResourceAccess.objects.create(
        resource=event.room, user=attendee, role=models.RoleChoices.MEMBER
    )

    with patch(
        "core.services.calendar_im_notify.deliver_event_change"
    ) as deliver, django_capture_on_commit_callbacks(execute=True):
        response = _client(old).post(
            f"/api/v1.0/calendar-events/{event.id}/transfer/",
            {
                "new_organizer_id": str(new.id),
                "keep_original_organizer": True,
            },
            format="json",
        )

    assert response.status_code == 200, response.content
    assert response.json()["id"] == str(event.id)
    assert response.json()["organizer"]["id"] == str(new.id)
    event.refresh_from_db()
    assert event.organizer == new
    assert event.source_calendar.owner == new
    assert event.room_id is not None
    assert event.attendees.filter(
        user=new,
        role=models.EventAttendeeRoleChoices.ORGANIZER,
        rsvp=models.EventRSVPChoices.ACCEPTED,
    ).exists()
    assert event.attendees.filter(
        user=old,
        role=models.EventAttendeeRoleChoices.REQUIRED,
        rsvp=models.EventRSVPChoices.ACCEPTED,
    ).exists()
    assert event.room.accesses.filter(
        user=new, role=models.RoleChoices.OWNER
    ).exists()
    assert event.room.accesses.filter(
        user=old, role=models.RoleChoices.MEMBER
    ).exists()

    deliver.assert_called_once()
    cid, source_card, sender, user_cards = deliver.call_args.args[0]
    assert cid == "source-cid"
    assert source_card["kind"] == "organizer_changed"
    assert source_card["organizer_name"] == "New organizer"
    assert sender == new
    recipients = {user.id for user, _card in user_cards}
    assert recipients == {old.id, new.id, attendee.id}
    assert {card["kind"] for _user, card in user_cards} == {"organizer_changed"}


def test_transfer_can_remove_original_organizer():
    organization = factories.OrganizationFactory()
    old = factories.UserFactory()
    new = factories.UserFactory()
    _membership(organization, old)
    _membership(organization, new)
    event = _event(organization, old, source_cid="")

    response = _client(old).post(
        f"/api/v1.0/calendar-events/{event.id}/transfer/",
        {
            "new_organizer_id": str(new.id),
            "keep_original_organizer": False,
        },
        format="json",
    )

    assert response.status_code == 200, response.content
    event.refresh_from_db()
    assert not event.attendees.filter(user=old).exists()
    assert not event.room.accesses.filter(user=old).exists()
    assert _client(old).get(f"/api/v1.0/calendar-events/{event.id}/").status_code == 404


def test_transfer_recurring_occurrence_moves_the_whole_series(
    django_capture_on_commit_callbacks,
):
    organization = factories.OrganizationFactory()
    old = factories.UserFactory()
    new = factories.UserFactory()
    _membership(organization, old)
    _membership(organization, new)
    parent = _event(organization, old, recurrence="FREQ=DAILY;COUNT=3")
    child = models.CalendarEvent.objects.create(
        organization=organization,
        organizer=old,
        source_calendar=parent.source_calendar,
        title=parent.title,
        start_at=parent.start_at + timedelta(days=1),
        end_at=parent.end_at + timedelta(days=1),
        recurrence_parent=parent,
        source_conversation_id=parent.source_conversation_id,
        room=parent.room,
    )
    models.EventAttendee.objects.create(
        event=child,
        user=old,
        role=models.EventAttendeeRoleChoices.ORGANIZER,
        rsvp=models.EventRSVPChoices.ACCEPTED,
    )

    with patch(
        "core.services.calendar_im_notify.deliver_event_change"
    ) as deliver, django_capture_on_commit_callbacks(execute=True):
        response = _client(old).post(
            f"/api/v1.0/calendar-events/{child.id}/transfer/",
            {"new_organizer_id": str(new.id)},
            format="json",
        )

    assert response.status_code == 200, response.content
    assert set(
        models.CalendarEvent.objects.filter(id__in=[parent.id, child.id]).values_list(
            "organizer_id", flat=True
        )
    ) == {new.id}
    assert models.EventAttendee.objects.filter(
        event_id__in=[parent.id, child.id],
        user=new,
        role=models.EventAttendeeRoleChoices.ORGANIZER,
    ).count() == 2
    card = deliver.call_args.args[0][1]
    assert card["kind"] == "organizer_changed"
    assert card["recurrence_scope"] == "all"
    assert card["event_id"] == str(child.id)


@pytest.mark.parametrize("actor_kind", ["attendee", "same_user"])
def test_only_current_organizer_can_transfer(actor_kind):
    organization = factories.OrganizationFactory()
    old = factories.UserFactory()
    actor = factories.UserFactory()
    _membership(organization, old)
    _membership(organization, actor)
    event = _event(organization, old)
    models.EventAttendee.objects.create(event=event, user=actor)
    target_id = actor.id if actor_kind == "same_user" else old.id

    response = _client(actor).post(
        f"/api/v1.0/calendar-events/{event.id}/transfer/",
        {"new_organizer_id": str(target_id)},
        format="json",
    )

    assert response.status_code == 403
    event.refresh_from_db()
    assert event.organizer == old


def test_transfer_rejects_self_and_non_internal_targets():
    organization = factories.OrganizationFactory()
    other_organization = factories.OrganizationFactory()
    old = factories.UserFactory()
    outsider = factories.UserFactory()
    _membership(organization, old)
    _membership(other_organization, outsider)
    event = _event(organization, old)
    client = _client(old)

    self_response = client.post(
        f"/api/v1.0/calendar-events/{event.id}/transfer/",
        {"new_organizer_id": str(old.id)},
        format="json",
    )
    outsider_response = client.post(
        f"/api/v1.0/calendar-events/{event.id}/transfer/",
        {"new_organizer_id": str(outsider.id)},
        format="json",
    )

    assert self_response.status_code == 400
    assert outsider_response.status_code == 400
    event.refresh_from_db()
    assert event.organizer == old
