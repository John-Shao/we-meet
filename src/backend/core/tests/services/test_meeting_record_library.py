"""Library metadata, exact capture links, ACL-before-filtering and pagination."""

from datetime import timedelta

from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

import pytest

from core import models
from core.factories import UserFactory
from core.tests.services.test_meeting_records import audio_note, client_for, online_note

pytestmark = pytest.mark.django_db
PATH = "/api/v1.0/meeting-records/"


@pytest.fixture(autouse=True)
def enabled(settings):
    settings.MEETING_RECORDS_ENABLED = True


def capture(record, *, stopped=False, device="device"):
    return models.CaptureSession.objects.create(
        record=record, created_by=record.owner, device_id=device,
        started_at=record.origin_at,
        status="stopped" if stopped else "paused",
        ended_at=record.origin_at + timedelta(seconds=10) if stopped else None,
    )


def test_owner_capture_link_is_exact_and_no_private_device_material_leaks():
    record = audio_note()
    source = capture(record)
    result = client_for(record.owner).get(f"{PATH}{record.pk}/").json()
    assert result["capture_id"] == str(source.pk)
    assert result["is_ongoing"] is True
    assert result["has_summary"] is False
    assert not {"device_id", "lease_hash", "lease_key"} & result.keys()
    reader = UserFactory()
    models.MeetingRecordAccess.objects.create(record=record, user=reader, read_transcript=True)
    assert client_for(reader).get(f"{PATH}{record.pk}/").json()["capture_id"] is None
    models.MeetingRecordAccess.objects.filter(record=record, user=reader).delete()
    assert client_for(reader).get(f"{PATH}{record.pk}/").status_code == 404


def test_multiple_historical_captures_do_not_resolve_to_latest():
    record = audio_note()
    capture(record, stopped=True)
    capture(record, stopped=True)
    result = client_for(record.owner).get(f"{PATH}{record.pk}/").json()
    assert result["capture_id"] is None
    assert result["is_ongoing"] is False


def test_ongoing_and_archive_are_disjoint_and_paginate_old_active_items():
    record = audio_note()
    source = capture(record)
    # An old paused recording must not disappear behind newer ended records.
    models.MeetingRecord.objects.filter(pk=record.pk).update(origin_at=timezone.now()-timedelta(days=30))
    archived = [audio_note(user=record.owner) for _ in range(31)]
    audio_note()  # private to another account
    client = client_for(record.owner)
    ongoing = client.get(PATH, {"is_ongoing": "true"}).json()
    assert [row["id"] for row in ongoing["results"]] == [str(record.pk)]
    assert ongoing["results"][0]["capture_id"] == str(source.pk)
    first = client.get(PATH, {"is_ongoing": "false"}).json()
    assert len(first["results"]) == 30 and first["next_cursor"]
    second = client.get(PATH, {"is_ongoing": "false", "cursor": first["next_cursor"]}).json()
    ids = [row["id"] for row in first["results"] + second["results"]]
    assert len(ids) == len(set(ids)) == 31
    assert set(ids) == {str(row.pk) for row in archived}
    assert second["next_cursor"] is None


def test_minutes_filter_requires_read_permission_and_exact_successful_source():
    owner, session, _, record = online_note()
    models.Summary.objects.create(room=session.room, session=session, status="success", content="notes")
    _, other, _, pending = online_note(user=owner)
    models.Summary.objects.create(room=other.room, session=other, status="pending")
    client = client_for(owner)
    assert [row["id"] for row in client.get(PATH, {"has_summary": "true"}).json()["results"]] == [str(record.pk)]
    reader = UserFactory()
    access = models.MeetingRecordAccess.objects.create(record=record, user=reader, read_transcript=True)
    shared = client_for(reader)
    assert shared.get(PATH, {"has_summary": "true"}).json()["results"] == []
    access.read_summary = True
    access.save()
    result = shared.get(PATH, {"has_summary": "true", "scope": "shared"}).json()
    assert len(result["results"]) == 1
    assert result["results"][0]["capture_id"] is None
    assert client.get(f"{PATH}{pending.pk}/").json()["has_summary"] is False


def test_active_online_session_and_strict_filter_validation():
    owner, session, _, record = online_note()
    models.MeetingSession.objects.filter(pk=session.pk).update(status="active", ended_at=None, end_reason="")
    client = client_for(owner)
    result = client.get(PATH, {"is_ongoing": "true", "source_type": "meeting"}).json()
    assert [row["id"] for row in result["results"]] == [str(record.pk)]
    for key in ("is_ongoing", "has_summary"):
        for value in ("", "1", "yes", "TRUE"):
            assert client.get(PATH, {key: value}).status_code == 400


def test_library_queries_are_bounded_independent_of_page_length():
    record = audio_note()
    capture(record, stopped=True)
    client = client_for(record.owner)
    with CaptureQueriesContext(connection) as one:
        assert client.get(PATH).status_code == 200
    for index in range(8):
        capture(audio_note(user=record.owner), stopped=True, device=str(index))
    with CaptureQueriesContext(connection) as many:
        result = client.get(PATH)
    assert len(result.json()["results"]) == 9
    assert len(many) == len(one)
