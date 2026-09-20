"""A record tombstone gates every read; restoring is not re-sharing or regenerating."""

import uuid
from urllib.parse import urlencode

from django.core.management import call_command
from django.utils import timezone

import pytest

from core import models
from core.factories import MembershipFactory, OrganizationFactory, UserFactory
from core.services import record_lifecycle as service
from core.services.meeting_records import RecordConflict, visible_records
from core.tests.services.test_meeting_record_speakers import capture_with_speakers
from core.tests.services.test_meeting_records import audio_note, client_for, online_note

pytestmark = pytest.mark.django_db
BASE = "/api/v1.0/meeting-records/"


def test_lifecycle_schema_matches_migrations():
    call_command("makemigrations", "core", check=True, dry_run=True, verbosity=0)


@pytest.fixture(autouse=True)
def flags(settings):
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_RECORD_TRASH_ENABLED = True
    settings.MEETING_CAPTURE_PROTOCOL_ENABLED = True


def change(record, target="trashed", revision=0, user=None):
    return client_for(user or record.owner).patch(
        f"{BASE}{record.pk}/lifecycle/",
        {"target": target, "expected_revision": revision},
        format="json",
    )


def test_trash_restore_preserves_content_but_revokes_sharing_and_automation():
    record = audio_note()
    capture_with_speakers(record)
    reader = UserFactory()
    models.MeetingRecordAccess.objects.create(
        record=record, user=reader, read_summary=True, read_transcript=True
    )
    automatic = models.MeetingSummaryAutomation.objects.create(
        record=record, requested_by=record.owner, enabled=True
    )
    original_ids = list(record.original_segments.values_list("pk", flat=True))
    assert change(record).status_code == 200
    assert not visible_records(record.owner).filter(pk=record.pk).exists()
    assert not visible_records(reader, include_trashed=True).exists()
    listing = client_for(record.owner).get(f"{BASE}trash/").json()
    assert listing["results"][0]["id"] == str(record.pk)
    assert set(listing["results"][0]) == {
        "id",
        "title",
        "source_type",
        "deleted_at",
        "lifecycle_revision",
        "purge",
    }
    assert not record.accesses.exists()
    automatic.refresh_from_db()
    assert not automatic.enabled and automatic.revision == 2
    assert change(record, "active", 1).status_code == 200
    assert visible_records(record.owner).filter(pk=record.pk).exists()
    assert not visible_records(reader).filter(pk=record.pk).exists()
    assert list(record.original_segments.values_list("pk", flat=True)) == original_ids
    record.refresh_from_db()
    assert record.revision == 1 and record.lifecycle_revision == 2
    automatic.refresh_from_db()
    assert not automatic.enabled


@pytest.mark.parametrize(
    "suffix",
    [
        "",
        "original-segments/",
        "speakers/",
        "summary-versions/",
        "human-summary/",
        "document-exports/",
        "media/",
    ],
)
def test_trashed_record_rejects_canonical_reads(suffix):
    record = audio_note()
    assert change(record).status_code == 200
    assert (
        client_for(record.owner).get(f"{BASE}{record.pk}/{suffix}").status_code == 404
    )


@pytest.mark.parametrize(
    "suffix", ["", "audio/", "transcription/", "translation/archives/"]
)
def test_old_capture_routes_cannot_bypass_trash(suffix):
    record = audio_note()
    capture, _ = capture_with_speakers(record)
    assert change(record).status_code == 200
    assert (
        client_for(record.owner)
        .get(f"/api/v1.0/capture-sessions/{capture.pk}/{suffix}")
        .status_code
        == 404
    )


def test_equivalent_retry_does_not_repeat_inverse_operation():
    record = audio_note()
    first = change(record).json()
    assert change(record).json() == first
    assert change(record, "active", 1).status_code == 200
    assert change(record).status_code == 409
    assert change(record, "trashed", 2).status_code == 200
    assert change(record, "active", 1).status_code == 409


@pytest.mark.parametrize("busy_kind", ["capture", "summary", "upload"])
def test_processing_or_recording_must_finish_before_trash(busy_kind):
    record = models.MeetingRecord.objects.create(
        owner=UserFactory(),
        source_type="upload" if busy_kind == "upload" else "audio_recording",
        origin_at=timezone.now(),
    )
    if busy_kind == "capture":
        capture, _ = capture_with_speakers(record)
        capture.status = "recording"
        capture.ended_at = None
        capture.save()
    elif busy_kind == "summary":
        record.processing_jobs.create(kind="summary", generation=1, input_revision=1)
    else:
        capture, _ = capture_with_speakers(record)
        models.UploadedRecording.objects.create(
            record=record,
            capture=capture,
            key=uuid.uuid4(),
            status="running",
            storage_name="fixture.wav",
            checksum="a" * 64,
            size=100,
            configuration={"context": "fixture"},
            deadline=timezone.now(),
            next_poll_at=timezone.now(),
        )
    assert change(record).status_code == 409
    record.refresh_from_db()
    assert record.deleted_at is None and record.lifecycle_revision == 0


def test_reader_online_and_inactive_owner_are_rejected():
    record = audio_note()
    reader = UserFactory()
    models.MeetingRecordAccess.objects.create(
        record=record, user=reader, read_summary=True
    )
    assert change(record, user=reader).status_code == 404
    _, _, _, online = online_note(record.owner)
    assert change(online, user=record.owner).status_code == 404
    record.owner.is_active = False
    record.owner.save()
    with pytest.raises(models.MeetingRecord.DoesNotExist):
        service.transition(record.pk, record.owner, "trashed", 0)


def test_restore_rechecks_organization_membership():
    organization = OrganizationFactory()
    record = audio_note(organization=organization)
    membership = MembershipFactory(user=record.owner, organization=organization)
    assert change(record).status_code == 200
    membership.delete()
    assert change(record, "active", 1).status_code == 404


def test_disabled_flag_does_not_make_trashed_data_readable(settings):
    record = audio_note()
    assert change(record).status_code == 200
    settings.MEETING_RECORD_TRASH_ENABLED = False
    assert change(record, "active", 1).status_code == 404
    assert client_for(record.owner).get(f"{BASE}trash/").status_code == 404
    assert client_for(record.owner).get(f"{BASE}{record.pk}/").status_code == 404


def test_trash_list_is_owner_scoped_and_paginated():
    owner = UserFactory()
    records = [audio_note(owner) for _ in range(32)]
    for record in records:
        service.transition(record.pk, owner, "trashed", 0)
    other = audio_note()
    service.transition(other.pk, other.owner, "trashed", 0)
    client = client_for(owner)
    first = client.get(f"{BASE}trash/").json()
    assert len(first["results"]) == 30
    second = client.get(
        f"{BASE}trash/?{urlencode({'cursor': first['next_cursor']})}"
    ).json()
    assert len(second["results"]) == 2 and second["next_cursor"] is None
    assert len({row["id"] for row in first["results"] + second["results"]}) == 32
