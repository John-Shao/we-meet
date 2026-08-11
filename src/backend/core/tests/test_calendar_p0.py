"""P0 validation, source-conversation authorization, and reminder re-arming."""

from datetime import timedelta
from unittest import mock

from django.utils import timezone

import pytest
from rest_framework.test import APIClient

from core import factories, models
from core.services import calendar_im_notify

pytestmark = pytest.mark.django_db


def _organizer_client():
    organization = factories.OrganizationFactory()
    user = factories.UserFactory()
    models.Membership.objects.create(
        organization=organization, user=user, is_primary=True
    )
    client = APIClient()
    client.force_login(user)
    return organization, user, client


def _payload(**overrides):
    start = timezone.now() + timedelta(days=3)
    return {
        "title": "Planning",
        "start_at": start.isoformat(),
        "end_at": (start + timedelta(hours=1)).isoformat(),
        "with_video_meeting": False,
        **overrides,
    }


@pytest.mark.parametrize("delta", [timedelta(0), -timedelta(minutes=1)])
def test_create_rejects_zero_or_negative_duration(delta):
    _org, _user, client = _organizer_client()
    start = timezone.now() + timedelta(days=1)

    response = client.post(
        "/api/v1.0/calendar-events/",
        _payload(start_at=start.isoformat(), end_at=(start + delta).isoformat()),
        format="json",
    )

    assert response.status_code == 400
    assert "end_at" in response.json()


def test_patch_rejects_range_invalid_against_existing_endpoint():
    organization, user, client = _organizer_client()
    event = _event(organization, user)

    response = client.patch(
        f"/api/v1.0/calendar-events/{event.id}/",
        {"end_at": event.start_at.isoformat()},
        format="json",
    )

    assert response.status_code == 400
    assert "end_at" in response.json()


@pytest.mark.parametrize("reminders", [[], [0], [45], [2880]])
def test_valid_single_reminder_values_are_accepted(reminders):
    _org, _user, client = _organizer_client()

    response = client.post(
        "/api/v1.0/calendar-events/",
        _payload(reminders=reminders),
        format="json",
    )

    assert response.status_code == 201, response.content
    assert response.json()["reminders"] == reminders


@pytest.mark.parametrize(
    "reminders",
    [None, 45, "45", [-1], ["45"], [True], [1.5], [5, 10], [2881]],
)
def test_invalid_reminder_values_are_rejected(reminders):
    _org, _user, client = _organizer_client()

    response = client.post(
        "/api/v1.0/calendar-events/",
        _payload(reminders=reminders),
        format="json",
    )

    assert response.status_code == 400
    assert "reminders" in response.json()


@pytest.mark.parametrize("legacy_reminders", [[5, 45], ["45"]])
def test_legacy_reminders_remain_readable_and_do_not_block_other_patch(
    legacy_reminders,
):
    organization, user, client = _organizer_client()
    event = _event(organization, user, reminders=legacy_reminders)

    detail = client.get(f"/api/v1.0/calendar-events/{event.id}/")
    patched = client.patch(
        f"/api/v1.0/calendar-events/{event.id}/",
        {"title": "Renamed"},
        format="json",
    )

    assert detail.status_code == 200
    assert detail.json()["reminders"] == legacy_reminders
    assert patched.status_code == 200, patched.content
    assert patched.json()["reminders"] == legacy_reminders


def test_source_membership_is_verified_before_create():
    _org, user, client = _organizer_client()

    with mock.patch.object(calendar_im_notify, "verify_source_membership") as verify:
        response = client.post(
            "/api/v1.0/calendar-events/",
            _payload(source_conversation_id="direct-or-group-cid"),
            format="json",
        )

    assert response.status_code == 201, response.content
    verify.assert_called_once_with(user, "direct-or-group-cid")
    event = models.CalendarEvent.objects.get(id=response.json()["id"])
    assert event.source_conversation_id == "direct-or-group-cid"
    assert "source_conversation_id" not in response.json()


def test_source_nonmember_returns_403_without_writing_any_event():
    _org, _user, client = _organizer_client()
    before = models.CalendarEvent.objects.count()

    with mock.patch.object(
        calendar_im_notify,
        "verify_source_membership",
        side_effect=calendar_im_notify.SourceConversationAccessDenied("forbidden"),
    ):
        response = client.post(
            "/api/v1.0/calendar-events/",
            _payload(source_conversation_id="missing-cid"),
            format="json",
        )

    assert response.status_code == 403
    assert models.CalendarEvent.objects.count() == before


def test_source_verification_failure_returns_503_without_writing_any_event():
    _org, _user, client = _organizer_client()
    before = models.CalendarEvent.objects.count()

    with mock.patch.object(
        calendar_im_notify,
        "verify_source_membership",
        side_effect=calendar_im_notify.SourceConversationVerificationUnavailable(
            "timeout"
        ),
    ):
        response = client.post(
            "/api/v1.0/calendar-events/",
            _payload(source_conversation_id="source-cid"),
            format="json",
        )

    assert response.status_code == 503
    assert models.CalendarEvent.objects.count() == before


@pytest.mark.parametrize("method", ["patch", "put"])
def test_source_conversation_cannot_be_added_or_rebound(method):
    organization, user, client = _organizer_client()
    event = _event(organization, user, source_conversation_id="original-cid")
    data = _payload(source_conversation_id="replacement-cid")
    if method == "patch":
        data = {"source_conversation_id": "replacement-cid"}

    response = getattr(client, method)(
        f"/api/v1.0/calendar-events/{event.id}/", data, format="json"
    )

    assert response.status_code == 400
    event.refresh_from_db()
    assert event.source_conversation_id == "original-cid"


def test_future_trigger_is_rearmed_after_start_change():
    organization, user, client = _organizer_client()
    event = _event(organization, user, reminders=[10], handled=True)
    start = timezone.now() + timedelta(hours=2)

    response = client.patch(
        f"/api/v1.0/calendar-events/{event.id}/",
        {
            "start_at": start.isoformat(),
            "end_at": (start + timedelta(hours=1)).isoformat(),
        },
        format="json",
    )

    assert response.status_code == 200, response.content
    event.refresh_from_db()
    assert event.reminder_pushed_at is None
    assert event.reminder_outcome == ""


def test_future_trigger_is_rearmed_after_reminder_change():
    organization, user, client = _organizer_client()
    event = _event(
        organization,
        user,
        start_at=timezone.now() + timedelta(days=3),
        reminders=[10],
        handled=True,
    )

    response = client.patch(
        f"/api/v1.0/calendar-events/{event.id}/",
        {"reminders": [2880]},
        format="json",
    )

    assert response.status_code == 200, response.content
    event.refresh_from_db()
    assert event.reminder_pushed_at is None
    assert event.reminder_outcome == ""


def test_end_only_change_does_not_rearm():
    organization, user, client = _organizer_client()
    event = _event(organization, user, reminders=[10], handled=True)
    handled_at = event.reminder_pushed_at

    response = client.patch(
        f"/api/v1.0/calendar-events/{event.id}/",
        {"end_at": (event.end_at + timedelta(minutes=30)).isoformat()},
        format="json",
    )

    assert response.status_code == 200, response.content
    event.refresh_from_db()
    assert event.reminder_pushed_at == handled_at
    assert event.reminder_outcome == "delivered"


def test_reschedule_to_past_trigger_does_not_rearm():
    organization, user, client = _organizer_client()
    event = _event(organization, user, reminders=[60], handled=True)
    handled_at = event.reminder_pushed_at

    response = client.patch(
        f"/api/v1.0/calendar-events/{event.id}/",
        {"start_at": (timezone.now() + timedelta(minutes=30)).isoformat()},
        format="json",
    )

    assert response.status_code == 200, response.content
    event.refresh_from_db()
    assert event.reminder_pushed_at == handled_at
    assert event.reminder_outcome == "delivered"


@pytest.mark.parametrize(
    "patch_data",
    [
        {"title": "Only a rename"},
        {"reminders": []},
        {"reminders": [60]},
    ],
)
def test_past_or_removed_trigger_does_not_rearm(patch_data):
    organization, user, client = _organizer_client()
    event = _event(
        organization,
        user,
        start_at=timezone.now() + timedelta(minutes=30),
        reminders=[10],
        handled=True,
    )
    handled_at = event.reminder_pushed_at

    response = client.patch(
        f"/api/v1.0/calendar-events/{event.id}/", patch_data, format="json"
    )

    assert response.status_code == 200, response.content
    event.refresh_from_db()
    assert event.reminder_pushed_at == handled_at
    assert event.reminder_outcome == "delivered"


def _event(  # noqa: PLR0913 - compact fixture builder keeps scenarios legible
    organization,
    user,
    *,
    start_at=None,
    reminders=None,
    source_conversation_id="",
    handled=False,
):
    start = start_at or timezone.now() + timedelta(hours=1)
    return models.CalendarEvent.objects.create(
        organization=organization,
        organizer=user,
        title="Existing event",
        start_at=start,
        end_at=start + timedelta(hours=1),
        reminders=[10] if reminders is None else reminders,
        source_conversation_id=source_conversation_id,
        reminder_pushed_at=timezone.now() if handled else None,
        reminder_outcome="delivered" if handled else "",
    )
