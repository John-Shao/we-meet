"""Unified calendar, sharing, and export safety contracts."""

from datetime import date, timedelta
from zoneinfo import ZoneInfo

from django.utils import timezone

import pytest
from rest_framework.renderers import JSONRenderer
from rest_framework.test import APIClient

from core import factories, models
from core.api.calendar_exports import CalendarExportJobSerializer
from core.services import calendar_exports


def member(organization, user):
    return models.Membership.objects.create(
        organization=organization, user=user, is_primary=True
    )


def api(user):
    client = APIClient()
    client.force_login(user)
    return client


@pytest.mark.django_db
def test_shared_calendar_writer_can_create_event_and_private_event_is_redacted():
    organization = factories.OrganizationFactory()
    owner, writer, reader = factories.UserFactory.create_batch(3)
    for user in (owner, writer, reader):
        member(organization, user)
    created = api(owner).post(
        "/api/v1.0/calendars/",
        {
            "name": "Launch",
            "organization_default_access": "details",
            "members": [{"user_id": str(writer.id), "role": "writer"}],
        },
        format="json",
    )
    assert created.status_code == 201, created.content
    calendar_id = created.json()["id"]
    subscribed = api(reader).put(
        f"/api/v1.0/calendars/{calendar_id}/subscription/",
        {"enabled": True},
        format="json",
    )
    assert subscribed.status_code == 200, subscribed.content
    start = timezone.now() + timedelta(days=1)
    event = api(writer).post(
        "/api/v1.0/calendar-events/",
        {
            "calendar_id": calendar_id,
            "title": "Secret launch",
            "start_at": start.isoformat(),
            "end_at": (start + timedelta(hours=1)).isoformat(),
            "visibility": "private",
            "with_video_meeting": False,
        },
        format="json",
    )
    assert event.status_code == 201, event.content
    assert event.json()["display_calendar_id"] == calendar_id
    detail = api(reader).get(f"/api/v1.0/calendar-events/{event.json()['id']}/")
    assert detail.status_code == 200, detail.content
    assert detail.json()["details_redacted"] is True
    assert detail.json()["title"] == ""


@pytest.mark.django_db
def test_primary_calendar_rejects_delegated_writer():
    organization = factories.OrganizationFactory()
    owner, colleague = factories.UserFactory.create_batch(2)
    member(organization, owner)
    member(organization, colleague)
    primary = api(owner).get("/api/v1.0/personal-calendars/mine/").json()
    response = api(owner).post(
        f"/api/v1.0/calendars/{primary['id']}/members/",
        {"user_id": str(colleague.id), "role": "writer"},
        format="json",
    )
    assert response.status_code == 400


@pytest.mark.django_db
def test_room_discovery_includes_the_timeline_summary_fields():
    organization = factories.OrganizationFactory()
    user = factories.UserFactory()
    member(organization, user)
    building = factories.MeetingRoomBuildingFactory(
        organization=organization,
        city_timezone="Asia/Shanghai",
        name="Tencent Tower",
    )
    television = factories.MeetingRoomFacilityFactory(
        organization=organization, name="TV", code="tv"
    )
    whiteboard = factories.MeetingRoomFacilityFactory(
        organization=organization, name="Whiteboard", code="whiteboard"
    )
    room = factories.MeetingRoomFactory(
        organization=organization,
        node=building,
        code="1602",
        name="Overlook",
        floor="16F",
        capacity=100,
    )
    room.facilities.set([television, whiteboard])

    response = api(user).get("/api/v1.0/calendars/discover/?type=room")

    assert response.status_code == 200, response.content
    discovered = response.json()[0]["meeting_room"]
    assert discovered["id"] == str(room.id)
    assert discovered["code"] == "1602"
    assert discovered["name"] == "Overlook"
    assert discovered["capacity"] == 100
    assert discovered["node"]["name"] == "Tencent Tower"
    assert discovered["path_label"].endswith("Tencent Tower · 16F")
    assert discovered["timezone"] == "Asia/Shanghai"
    assert [facility["name"] for facility in discovered["facilities"]] == [
        "TV",
        "Whiteboard",
    ]


@pytest.mark.django_db
def test_reset_share_link_revokes_old_token():
    organization = factories.OrganizationFactory()
    owner, colleague = factories.UserFactory.create_batch(2)
    member(organization, owner)
    member(organization, colleague)
    calendar = models.Calendar.objects.create(
        organization=organization,
        owner=owner,
        kind=models.CalendarKindChoices.SHARED,
        name="Roadmap",
        organization_default_access=models.CalendarAccessChoices.DETAILS,
    )
    first = api(owner).get(f"/api/v1.0/calendars/{calendar.id}/share-link/").json()
    reset = api(owner).post(f"/api/v1.0/calendars/{calendar.id}/share-link/").json()
    assert first["token"] != reset["token"]
    assert (
        api(colleague).get(f"/api/v1.0/calendar-share/{first['token']}/").status_code
        == 404
    )
    assert (
        api(colleague).post(f"/api/v1.0/calendar-share/{reset['token']}/").status_code
        == 200
    )


def test_csv_cells_are_bom_encoded_and_formula_safe():
    content = calendar_exports._csv_bytes(
        [["Subject", "Description"], ["=1+1", "@SUM(A1:A2)"]]
    )
    assert content.startswith(b"\xef\xbb\xbf")
    decoded = content.decode("utf-8-sig")
    assert "'=1+1" in decoded
    assert "'@SUM(A1:A2)" in decoded


def test_calendar_export_job_timezone_is_json_serializable():
    calendar = models.Calendar(
        kind=models.CalendarKindChoices.SHARED,
        name="Roadmap",
    )
    job = models.CalendarExportJob(
        calendar=calendar,
        range_start=date(2026, 8, 13),
        range_end=date(2026, 8, 13),
        timezone=ZoneInfo("Asia/Shanghai"),
    )

    data = CalendarExportJobSerializer(job).data

    assert data["timezone"] == "Asia/Shanghai"
    assert JSONRenderer().render(data)
