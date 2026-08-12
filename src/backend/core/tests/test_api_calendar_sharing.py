"""P1-8b personal calendar sharing and per-event visibility tests."""

from datetime import timedelta
from unittest import mock

from django.utils import timezone

import pytest
from rest_framework.test import APIClient

from core import factories, models
from core.services import calendar_im_notify

pytestmark = pytest.mark.django_db


def membership(organization, user):
    return models.Membership.objects.create(
        organization=organization,
        user=user,
        is_primary=True,
    )


def event_for(organization, organizer, visibility="default"):
    start = timezone.now() + timedelta(days=1)
    event = models.CalendarEvent.objects.create(
        organization=organization,
        organizer=organizer,
        title="Sensitive roadmap",
        description="full details",
        start_at=start,
        end_at=start + timedelta(hours=1),
        visibility=visibility,
    )
    models.EventAttendee.objects.create(
        event=event,
        user=organizer,
        role=models.EventAttendeeRoleChoices.ORGANIZER,
        rsvp=models.EventRSVPChoices.ACCEPTED,
    )
    return event


def subscribe(owner, viewer, organization, permission="free_busy"):
    calendar = models.PersonalCalendar.objects.create(
        organization=organization,
        owner=owner,
        organization_default_access=permission,
    )
    models.CalendarSubscription.objects.create(
        calendar=calendar,
        subscriber=viewer,
    )
    return calendar


def client(user):
    api = APIClient()
    api.force_login(user)
    return api


@pytest.mark.parametrize("visibility", ["default", "public", "private"])
def test_arbitrary_event_id_is_not_an_access_grant(visibility):
    organization = factories.OrganizationFactory()
    owner = factories.UserFactory()
    outsider = factories.UserFactory()
    membership(organization, owner)
    membership(organization, outsider)
    event = event_for(organization, owner, visibility)

    response = client(outsider).get(f"/api/v1.0/calendar-events/{event.id}/")

    assert response.status_code == 404


@pytest.mark.parametrize(
    ("visibility", "redacted"),
    [("default", False), ("public", False), ("private", True)],
)
def test_source_conversation_member_access(visibility, redacted):
    organization = factories.OrganizationFactory()
    owner = factories.UserFactory()
    viewer = factories.UserFactory()
    membership(organization, owner)
    membership(organization, viewer)
    event = event_for(organization, owner, visibility)
    event.source_conversation_id = "group-123"
    event.save(update_fields=["source_conversation_id", "updated_at"])
    with mock.patch(
        "core.services.calendar_access.calendar_im_notify.verify_source_membership"
    ) as verify:
        response = client(viewer).get(f"/api/v1.0/calendar-events/{event.id}/")

    assert response.status_code == 200, response.content
    assert response.json()["details_redacted"] is redacted
    verify.assert_called_once_with(viewer, "group-123")


@pytest.mark.parametrize(
    ("error", "status_code"),
    [
        (calendar_im_notify.SourceConversationAccessDenied("left"), 404),
        (
            calendar_im_notify.SourceConversationVerificationUnavailable("down"),
            503,
        ),
    ],
)
def test_source_conversation_access_fails_closed(error, status_code):
    organization = factories.OrganizationFactory()
    owner = factories.UserFactory()
    viewer = factories.UserFactory()
    membership(organization, owner)
    membership(organization, viewer)
    event = event_for(organization, owner)
    event.source_conversation_id = "group-123"
    event.save(update_fields=["source_conversation_id", "updated_at"])
    with mock.patch(
        "core.services.calendar_access.calendar_im_notify.verify_source_membership",
        side_effect=error,
    ):
        response = client(viewer).get(f"/api/v1.0/calendar-events/{event.id}/")

    assert response.status_code == status_code


@pytest.mark.parametrize(
    ("permission", "visibility", "redacted"),
    [
        ("free_busy", "default", True),
        ("free_busy", "public", False),
        ("free_busy", "private", True),
        ("details", "default", False),
        ("details", "public", False),
        ("details", "private", True),
    ],
)
def test_subscription_and_event_visibility_matrix(permission, visibility, redacted):
    organization = factories.OrganizationFactory()
    owner = factories.UserFactory()
    viewer = factories.UserFactory()
    membership(organization, owner)
    membership(organization, viewer)
    calendar = subscribe(owner, viewer, organization, permission)
    event = event_for(organization, owner, visibility)

    detail = client(viewer).get(f"/api/v1.0/calendar-events/{event.id}/")
    feed = client(viewer).get(
        f"/api/v1.0/personal-calendars/{calendar.id}/events/"
    )

    assert detail.status_code == 200, detail.content
    assert feed.status_code == 200, feed.content
    assert detail.json()["details_redacted"] is redacted
    assert feed.json()[0]["details_redacted"] is redacted
    assert detail.json()["title"] == ("" if redacted else event.title)
    if redacted:
        assert detail.json()["description"] == ""
        assert detail.json()["organizer"] is None
        assert detail.json()["attendees"] == []
        assert detail.json()["room_slug"] is None


def test_participant_always_reads_private_event_details():
    organization = factories.OrganizationFactory()
    owner = factories.UserFactory()
    invitee = factories.UserFactory()
    membership(organization, owner)
    membership(organization, invitee)
    event = event_for(organization, owner, "private")
    models.EventAttendee.objects.create(event=event, user=invitee)

    response = client(invitee).get(f"/api/v1.0/calendar-events/{event.id}/")

    assert response.status_code == 200
    assert response.json()["details_redacted"] is False
    assert response.json()["title"] == event.title


def test_external_attendee_event_is_projected_onto_their_personal_calendar():
    organization = factories.OrganizationFactory()
    partner_organization = factories.OrganizationFactory()
    owner = factories.UserFactory()
    partner = factories.UserFactory()
    membership(organization, owner)
    membership(partner_organization, partner)
    event = event_for(organization, owner)
    models.EventAttendee.objects.create(
        event=event,
        user=partner,
        rsvp=models.EventRSVPChoices.ACCEPTED,
    )
    partner_calendar = models.PersonalCalendar.objects.create(
        organization=partner_organization,
        owner=partner,
    )

    response = client(partner).get(
        f"/api/v1.0/personal-calendars/{partner_calendar.id}/events/"
    )

    assert response.status_code == 200, response.content
    assert [row["id"] for row in response.json()] == [str(event.id)]


def test_calendar_owner_can_set_default_and_manage_grant():
    organization = factories.OrganizationFactory()
    owner = factories.UserFactory()
    viewer = factories.UserFactory()
    membership(organization, owner)
    membership(organization, viewer)
    mine = client(owner).get("/api/v1.0/personal-calendars/mine/")
    assert mine.status_code == 200
    calendar_id = mine.json()["id"]

    changed = client(owner).patch(
        f"/api/v1.0/personal-calendars/{calendar_id}/",
        {"organization_default_access": "details"},
        format="json",
    )
    grant = client(owner).post(
        "/api/v1.0/calendar-access-grants/",
        {"grantee_user_id": str(viewer.id), "permission": "free_busy"},
        format="json",
    )
    subscription = client(viewer).post(
        "/api/v1.0/calendar-subscriptions/",
        {"owner_user_id": str(owner.id), "color": "#2563eb"},
        format="json",
    )

    assert changed.status_code == 200, changed.content
    assert changed.json()["organization_default_access"] == "details"
    assert grant.status_code == 201, grant.content
    assert grant.json()["permission"] == "free_busy"
    assert subscription.status_code == 201, subscription.content
    assert subscription.json()["permission"] == "free_busy"


def test_external_subscription_requires_contact_and_grant_then_is_revoked():
    organization = factories.OrganizationFactory()
    partner_organization = factories.OrganizationFactory()
    owner = factories.UserFactory()
    partner = factories.UserFactory()
    membership(organization, owner)
    membership(partner_organization, partner)
    owner_calendar = models.PersonalCalendar.objects.create(
        organization=organization,
        owner=owner,
    )

    denied = client(partner).post(
        "/api/v1.0/calendar-subscriptions/",
        {"owner_user_id": str(owner.id)},
        format="json",
    )
    assert denied.status_code == 403

    user_a, user_b = models.ExternalContact.canonical_pair(owner, partner)
    relationship = models.ExternalContact.objects.create(
        user_a=user_a,
        user_b=user_b,
        requested_by=owner,
        status=models.ExternalContactStatusChoices.ACCEPTED,
    )
    grant = models.CalendarAccessGrant.objects.create(
        calendar=owner_calendar,
        grantee=partner,
        permission=models.CalendarAccessChoices.DETAILS,
    )
    subscribed = client(partner).post(
        "/api/v1.0/calendar-subscriptions/",
        {"owner_user_id": str(owner.id)},
        format="json",
    )
    assert subscribed.status_code == 201, subscribed.content

    removed = client(owner).delete(
        f"/api/v1.0/directory/external-contacts/{relationship.id}/"
    )

    assert removed.status_code == 204
    assert not models.CalendarAccessGrant.objects.filter(id=grant.id).exists()
    assert not models.CalendarSubscription.objects.filter(
        calendar=owner_calendar, subscriber=partner
    ).exists()


def test_legacy_edit_does_not_downgrade_public_without_explicit_marker():
    organization = factories.OrganizationFactory()
    owner = factories.UserFactory()
    membership(organization, owner)
    event = event_for(organization, owner, "public")
    api = client(owner)

    legacy = api.patch(
        f"/api/v1.0/calendar-events/{event.id}/",
        {"title": "Renamed", "visibility": "default"},
        format="json",
    )
    explicit = api.patch(
        f"/api/v1.0/calendar-events/{event.id}/",
        {"visibility": "default", "visibility_explicit": True},
        format="json",
    )

    assert legacy.status_code == 200, legacy.content
    assert legacy.json()["visibility"] == "public"
    assert explicit.status_code == 200, explicit.content
    assert explicit.json()["visibility"] == "default"
