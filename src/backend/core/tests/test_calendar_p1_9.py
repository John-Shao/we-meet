"""P1-9 all-day civil dates and cross-device calendar preferences."""

from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest
from rest_framework.test import APIClient

from core import factories, models
from core.services import calendar_im_notify, calendar_recurrence, calendar_time

pytestmark = pytest.mark.django_db


def _client():
    organization = factories.OrganizationFactory()
    user = factories.UserFactory(timezone="Asia/Shanghai")
    models.Membership.objects.create(
        organization=organization, user=user, is_primary=True
    )
    client = APIClient()
    client.force_login(user)
    return client, organization, user


def test_all_day_create_uses_civil_dates_as_source_of_truth():
    client, _, _ = _client()
    response = client.post(
        "/api/v1.0/calendar-events/",
        {
            "title": "Los Angeles holiday",
            "all_day": True,
            "start_date": "2026-11-01",
            "end_date": "2026-11-02",
            "timezone": "America/Los_Angeles",
            "with_video_meeting": False,
        },
        format="json",
    )
    assert response.status_code == 201, response.content
    payload = response.json()
    assert payload["start_date"] == "2026-11-01"
    assert payload["end_date"] == "2026-11-02"

    event = models.CalendarEvent.objects.get(pk=payload["id"])
    zone = ZoneInfo("America/Los_Angeles")
    assert event.start_at.astimezone(zone).isoformat().startswith("2026-11-01T00:00:00")
    assert event.end_at.astimezone(zone).isoformat().startswith("2026-11-02T00:00:00")


@pytest.mark.parametrize(
    ("patch", "field"),
    [
        ({"start_date": "2026-08-12", "end_date": "2026-08-12"}, "end_date"),
        ({"timezone": "Mars/Olympus_Mons"}, "timezone"),
    ],
)
def test_all_day_rejects_invalid_date_range_and_timezone(patch, field):
    client, _, _ = _client()
    payload = {
        "title": "Invalid",
        "all_day": True,
        "start_date": "2026-08-12",
        "end_date": "2026-08-13",
        "timezone": "Asia/Shanghai",
        "with_video_meeting": False,
        **patch,
    }
    response = client.post("/api/v1.0/calendar-events/", payload, format="json")
    assert response.status_code == 400
    assert field in response.json()


def test_legacy_anchor_cannot_move_canonical_all_day_event():
    client, _, _ = _client()
    created = client.post(
        "/api/v1.0/calendar-events/",
        {
            "title": "Stable date",
            "all_day": True,
            "start_date": "2026-08-12",
            "end_date": "2026-08-13",
            "timezone": "Asia/Shanghai",
            "with_video_meeting": False,
        },
        format="json",
    ).json()
    response = client.patch(
        f"/api/v1.0/calendar-events/{created['id']}/",
        {
            "start_at": "2026-08-12T00:00:00Z",
            "end_at": "2026-08-13T00:00:00Z",
        },
        format="json",
    )
    assert response.status_code == 400
    assert "all_day_dates_required" in str(response.json())


def test_date_window_filters_all_day_by_civil_date():
    client, organization, user = _client()
    start_at, end_at = calendar_time.all_day_anchors(
        date(2026, 8, 12), date(2026, 8, 13), "Pacific/Kiritimati"
    )
    event = models.CalendarEvent.objects.create(
        organization=organization,
        organizer=user,
        title="UTC plus fourteen",
        start_at=start_at,
        end_at=end_at,
        start_date=date(2026, 8, 12),
        end_date=date(2026, 8, 13),
        timezone="Pacific/Kiritimati",
        all_day=True,
    )
    models.EventAttendee.objects.create(
        event=event,
        user=user,
        role=models.EventAttendeeRoleChoices.ORGANIZER,
    )
    unrelated_timed = models.CalendarEvent.objects.create(
        organization=organization,
        organizer=user,
        title="Outside an instant window",
        start_at=datetime(2030, 1, 1, tzinfo=timezone.utc),
        end_at=datetime(2030, 1, 1, 1, tzinfo=timezone.utc),
        timezone="UTC",
    )
    models.EventAttendee.objects.create(
        event=unrelated_timed,
        user=user,
        role=models.EventAttendeeRoleChoices.ORGANIZER,
    )
    response = client.get(
        "/api/v1.0/calendar-events/?date_start=2026-08-12&date_end=2026-08-13"
    )
    assert response.status_code == 200
    result_ids = {row["id"] for row in response.json()["results"]}
    assert str(event.id) in result_ids
    assert str(unrelated_timed.id) not in result_ids


def test_all_day_recurrence_keeps_local_midnights_across_dst():
    _, organization, user = _client()
    start_date, end_date = date(2027, 3, 7), date(2027, 3, 8)
    start_at, end_at = calendar_time.all_day_anchors(
        start_date, end_date, "America/Los_Angeles"
    )
    parent = models.CalendarEvent.objects.create(
        organization=organization,
        organizer=user,
        title="Weekly all-day",
        start_at=start_at,
        end_at=end_at,
        start_date=start_date,
        end_date=end_date,
        timezone="America/Los_Angeles",
        all_day=True,
        recurrence="FREQ=WEEKLY;COUNT=3",
    )
    models.EventAttendee.objects.create(
        event=parent,
        user=user,
        role=models.EventAttendeeRoleChoices.ORGANIZER,
    )
    calendar_recurrence.materialize_parent(
        parent,
        now=datetime(2027, 3, 6, tzinfo=timezone.utc),
        horizon_days=30,
    )
    zone = ZoneInfo("America/Los_Angeles")
    children = list(parent.occurrences.order_by("start_date"))
    assert [child.start_date for child in children] == [
        date(2027, 3, 14),
        date(2027, 3, 21),
    ]
    assert all(
        child.end_date == child.start_date + timedelta(days=1) for child in children
    )
    assert all(child.start_at.astimezone(zone).hour == 0 for child in children)
    assert all(child.end_at.astimezone(zone).hour == 0 for child in children)


def test_all_day_series_all_edit_uses_selected_occurrence_civil_delta():
    _, organization, user = _client()
    zone = ZoneInfo("America/Los_Angeles")
    start_date, end_date = date(2027, 3, 7), date(2027, 3, 8)
    start_at, end_at = calendar_time.all_day_anchors(start_date, end_date, zone)
    parent = models.CalendarEvent.objects.create(
        organization=organization,
        organizer=user,
        title="Weekly all-day",
        start_at=start_at,
        end_at=end_at,
        start_date=start_date,
        end_date=end_date,
        timezone=zone,
        all_day=True,
        recurrence="FREQ=WEEKLY;COUNT=3",
    )
    models.EventAttendee.objects.create(
        event=parent,
        user=user,
        role=models.EventAttendeeRoleChoices.ORGANIZER,
    )
    now = datetime(2027, 3, 6, tzinfo=timezone.utc)
    calendar_recurrence.materialize_parent(parent, now=now, horizon_days=30)
    selected = parent.occurrences.get(start_date=date(2027, 3, 14))
    moved_start, moved_end = calendar_time.all_day_anchors(
        date(2027, 3, 15), date(2027, 3, 16), zone
    )

    calendar_recurrence.edit_series_all(
        parent,
        selected.start_at,
        {
            "start_at": moved_start,
            "end_at": moved_end,
            "start_date": date(2027, 3, 15),
            "end_date": date(2027, 3, 16),
            "timezone": "America/Los_Angeles",
        },
        now=now,
        schedule_changed=True,
    )

    parent.refresh_from_db()
    assert parent.start_date == date(2027, 3, 8)
    assert parent.end_date == date(2027, 3, 9)
    assert parent.start_at.astimezone(zone).hour == 0
    children = list(parent.occurrences.order_by("start_date"))
    assert [child.start_date for child in children] == [
        date(2027, 3, 15),
        date(2027, 3, 22),
    ]
    assert all(child.start_at.astimezone(zone).hour == 0 for child in children)


def test_all_day_event_card_carries_canonical_dates():
    _, organization, user = _client()
    start_at, end_at = calendar_time.all_day_anchors(
        date(2026, 8, 12), date(2026, 8, 15), "Asia/Shanghai"
    )
    event = models.CalendarEvent.objects.create(
        organization=organization,
        organizer=user,
        title="Company offsite",
        start_at=start_at,
        end_at=end_at,
        start_date=date(2026, 8, 12),
        end_date=date(2026, 8, 15),
        timezone="Asia/Shanghai",
        all_day=True,
    )

    card = calendar_im_notify.build_event_card(event, "created")

    assert card["start_date"] == "2026-08-12"
    assert card["end_date"] == "2026-08-15"

    changed = calendar_im_notify.build_event_card(
        event,
        "time_changed",
        old_start=start_at,
        old_end=end_at,
        old_start_date=date(2026, 8, 12),
        old_end_date=date(2026, 8, 15),
        # Series-all cards show the occurrence the user acted on, not the
        # parent series' first occurrence.
        display_start_date=date(2026, 8, 20),
        display_end_date=date(2026, 8, 22),
    )
    assert changed["start_date"] == "2026-08-20"
    assert changed["end_date"] == "2026-08-22"
    assert changed["old_start_date"] == "2026-08-12"
    assert changed["old_end_date"] == "2026-08-15"


def test_calendar_preferences_initialize_and_detect_stale_revision():
    client, _, _ = _client()
    initial = client.get("/api/v1.0/calendar-preferences/me/")
    assert initial.status_code == 200
    assert initial.json()["initialized"] is False
    assert initial.json()["revision"] == 0

    missing_revision = client.patch(
        "/api/v1.0/calendar-preferences/me/",
        {"dim_past": False},
        format="json",
    )
    assert missing_revision.status_code == 400
    assert "expected_revision" in missing_revision.json()

    saved = client.patch(
        "/api/v1.0/calendar-preferences/me/",
        {
            "expected_revision": 0,
            "timezone_mode": "fixed",
            "timezone": "Europe/Paris",
            "week_start": "sun",
            "working_start_minutes": 480,
            "working_end_minutes": 1020,
        },
        format="json",
    )
    assert saved.status_code == 200, saved.content
    assert saved.json()["initialized"] is True
    assert saved.json()["revision"] == 1
    assert saved.json()["timezone"] == "Europe/Paris"

    stale = client.patch(
        "/api/v1.0/calendar-preferences/me/",
        {"expected_revision": 0, "dim_past": False},
        format="json",
    )
    assert stale.status_code == 409
    assert stale.json()["code"] == "calendar_preference_conflict"
