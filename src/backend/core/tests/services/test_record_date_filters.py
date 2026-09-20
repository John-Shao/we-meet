"""Creation date filters combine with ACL and scope before pagination."""

from datetime import datetime, timedelta, timezone

import pytest

from core import models
from core.factories import UserFactory
from core.tests.services.test_meeting_records import audio_note, client_for

pytestmark = pytest.mark.django_db
PATH = "/api/v1.0/meeting-records/"


@pytest.fixture(autouse=True)
def enabled(settings):
    settings.MEETING_RECORDS_ENABLED = True


@pytest.mark.parametrize("ordering", ["created_at", "-created_at"])
def test_dates_scope_source_title_and_acl_apply_before_paging(ordering):
    owner = UserFactory()
    begin = datetime(2026, 9, 19, 16, tzinfo=timezone.utc)
    expected = []
    for index in range(35):
        record = audio_note(user=owner)
        created = begin + timedelta(minutes=index - 1)
        models.MeetingRecord.objects.filter(pk=record.pk).update(
            created_at=created,
            title="Date acceptance",
            origin_at=begin - timedelta(days=90),
        )
        if index > 0:
            expected.append((created, str(record.pk)))
    # Private, wrong title and out-of-range records cannot dilute the first page.
    for record in (audio_note(), audio_note(user=owner)):
        models.MeetingRecord.objects.filter(pk=record.pk).update(created_at=begin)
    params = {
        "created_from": "2026-09-20T00:00:00+08:00",
        "created_before": "2026-09-21T00:00:00+08:00",
        "scope": "owned",
        "source_type": "audio_recording",
        "q": "Date acceptance",
        "ordering": ordering,
    }
    client = client_for(owner)
    first = client.get(PATH, params).json()
    second = client.get(PATH, {**params, "cursor": first["next_cursor"]}).json()
    assert first["supported_filters"] == ["created_from", "created_before"]
    assert len(first["results"]) == 30 and len(second["results"]) == 4
    assert [r["id"] for r in first["results"] + second["results"]] == [
        pk for _, pk in sorted(expected, reverse=ordering.startswith("-"))
    ]
    assert second["next_cursor"] is None


def test_inclusive_start_exclusive_end_and_shared_access_revocation():
    reader = UserFactory()
    record = audio_note()
    access = models.MeetingRecordAccess.objects.create(
        record=record, user=reader, read_transcript=True
    )
    models.MeetingRecord.objects.filter(pk=record.pk).update(
        created_at=datetime(2026, 9, 20, tzinfo=timezone.utc)
    )
    client = client_for(reader)
    params = {"scope": "shared", "created_from": "2026-09-20T00:00:00Z"}
    assert [r["id"] for r in client.get(PATH, params).json()["results"]] == [
        str(record.pk)
    ]
    assert (
        client.get(PATH, {"created_before": params["created_from"]}).json()["results"]
        == []
    )
    access.delete()
    assert client.get(PATH, params).json()["results"] == []


@pytest.mark.parametrize(
    "params",
    [
        {"created_from": ""},
        {"created_from": "2026-09-20"},
        {"created_from": "2026-09-20T00:00:00"},
        {"created_before": "invalid"},
        {"created_before": "2026-02-30T00:00:00Z"},
        {
            "created_from": "2026-09-21T00:00:00Z",
            "created_before": "2026-09-20T00:00:00Z",
        },
        {
            "created_from": "2026-09-20T00:00:00Z",
            "created_before": "2026-09-20T00:00:00Z",
        },
        {"created_from": ["2026-09-20T00:00:00Z", "2026-09-21T00:00:00Z"]},
    ],
)
def test_rejects_ambiguous_invalid_or_reversed_range(params):
    assert client_for(UserFactory()).get(PATH, params).status_code == 400
