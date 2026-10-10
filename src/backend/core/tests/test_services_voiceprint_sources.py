"""Immutable published source scope and deterministic clean interval selection."""

import hashlib
from dataclasses import replace
from datetime import timedelta
from uuid import UUID, uuid4

from django.db.models import F
from django.utils import timezone

import pytest

from core import models
from core.factories import MembershipFactory, OrganizationFactory, UserFactory
from core.services import voiceprint_source_intervals as intervals
from core.services import voiceprint_source_objects as objects
from core.services import voiceprint_sources as sources
from core.services.voiceprint_consent import VoiceprintError

A, B = UUID(int=1), UUID(int=2)


def row(speaker, start, end):
    return intervals.SourceInterval(speaker, start, end)


def test_overlap_unknown_and_same_speaker_boundaries():
    rows = [
        row(A, 0, 10000),
        row(A, 10000, 20000),
        row(B, 7000, 11000),
        row(None, 14000, 16000),
    ]
    safe = intervals.clean_ranges(rows)
    assert safe[A] == ((100, 6900), (16100, 19900))
    assert B not in safe or not safe[B]
    joined = intervals.clean_ranges([row(A, 0, 5000), row(A, 5000, 10000)])
    assert joined[A] == ((100, 9900),)


def test_distribution_capped_and_does_not_create_source_overlap():
    chosen = intervals.select([row(A, 0, 7200000)], duration_ms=7200000)[A]
    assert len(chosen) == 12
    assert chosen[0].start_ms == 100 and chosen[-1].start_ms > 7100000
    assert all(
        right.start_ms >= left.end_ms
        for left, right in zip(chosen, chosen[1:], strict=False)
    )
    assert all(3000 <= item.end_ms - item.start_ms <= 10000 for item in chosen)


def test_minimum_independent_clips_uses_available_short_clean_audio():
    chosen = intervals.select([row(A, 0, 9200)], duration_ms=9200)[A]
    assert len(chosen) == 3
    assert all(item.end_ms - item.start_ms == 3000 for item in chosen)
    assert len(intervals.select([row(A, 0, 6100)], duration_ms=6100)[A]) == 1


def test_disconnected_time_ranges_are_never_joined():
    chosen = intervals.select(
        [row(A, 0, 3400), row(A, 10000, 13400), row(A, 30000, 33400)], duration_ms=33400
    )[A]
    assert [(item.start_ms, item.end_ms) for item in chosen] == [
        (100, 3300),
        (10100, 13300),
        (30100, 33300),
    ]


@pytest.mark.parametrize(
    "damaged",
    [
        row(A, True, 4000),
        row(A, 4000, 3000),
        row(A, 0, 7200001),
        row("client-label", 0, 4000),
        row(A, 0, None),
    ],
)
def test_invalid_source_times_and_client_labels(damaged):
    with pytest.raises(ValueError):
        intervals.select([damaged], duration_ms=10000)


def test_source_duration_and_speaker_capacity_are_bounded():
    with pytest.raises(ValueError, match="time_mapping"):
        intervals.select([row(A, 0, 10000)], duration_ms=9000)
    with pytest.raises(ValueError, match="speakers_exceeded"):
        intervals.clean_ranges([row(UUID(int=i + 1), 0, 4000) for i in range(51)])
    with pytest.raises(ValueError):
        intervals.clean_ranges([row(A, 0, 4000)] * 20001)


def receipt():
    return objects.ObjectReceipt(
        "content_sha256", "record-uploads/synthetic.wav", 144044, sha256="a" * 64
    )


@pytest.mark.parametrize(
    "changes",
    [
        {"schema": True},
        {"schema": 2},
        {"url": "https://example.com"},
        {"size": True},
        {"key": "record-uploads/../private"},
        {"sha256": "A" * 64},
        {"kind": "upload_intent"},
    ],
)
def test_receipts_are_strict_and_never_trust_client_claims(changes):
    with pytest.raises(ValueError):
        objects.parse({**receipt().payload(), **changes})


def test_etag_is_an_object_token_and_never_a_content_sha():
    proof = objects.from_head(
        receipt().key,
        receipt().size,
        {
            "ContentLength": receipt().size,
            "ETag": '"opaque-token"',
            "VersionId": "version-1",
        },
    )
    actual = objects.parse(proof)
    assert actual.kind == "s3_object" and actual.sha256 == ""
    assert actual.etag == '"opaque-token"' and actual.version_id == "version-1"
    assert "opaque-token" not in repr(actual) and actual.key not in repr(actual)
    assert (
        objects.from_head(actual.key, actual.size, {"ContentLength": actual.size})
        is None
    )
    assert (
        objects.from_head(
            actual.key,
            actual.size,
            {"ContentLength": actual.size, "ETag": '"bad\r\nheader"'},
        )
        is None
    )


@pytest.fixture
def published(settings):
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_VOICEPRINT_ENABLED = True
    settings.MEETING_VOICEPRINT_MATCHING_ENABLED = True
    actor = UserFactory()
    now = timezone.now()
    record = models.MeetingRecord.objects.create(
        owner=actor, source_type="upload", retention_mode="media", origin_at=now
    )
    capture = models.CaptureSession.objects.create(
        record=record,
        created_by=actor,
        device_id=str(uuid4()),
        status="stopped",
        started_at=now,
        ended_at=now,
    )
    object_proof = receipt()
    job = models.UploadedRecording.objects.create(
        record=record,
        capture=capture,
        key=uuid4(),
        storage_name=object_proof.key,
        checksum=object_proof.sha256,
        size=object_proof.size,
        status="succeeded",
        deadline=now + timedelta(hours=24),
        next_poll_at=now,
        configuration={
            "diarization": True,
            "_identity_source": object_proof.payload(),
            "_published": {"segment_count": 3, "attempt": 1},
        },
    )
    speaker = models.MeetingSpeaker.objects.create(
        record=record,
        capture_session=capture,
        source_track_id="uploaded-file",
        source_key="0",
        label="Speaker 0",
        identity_type="diarized",
    )
    for i in range(3):
        models.MeetingOriginalSegment.objects.create(
            record=record,
            capture_session=capture,
            speaker=speaker,
            ingest_id=uuid4(),
            source_track_id="uploaded-file",
            source_sequence=i + 1,
            start_ms=i * 10000,
            end_ms=i * 10000 + 4000,
            text="private text",
            payload_hash=hashlib.sha256(b"private text").hexdigest(),
        )
    return actor, record, job, speaker


@pytest.mark.django_db
def test_published_source_snapshot_does_not_expose_text_or_keys(published):
    actor, record, job, speaker = published
    source = sources.snapshot(record, actor, expected_revision=1)
    assert sources.authorized(source) and sources.revalidate(source)
    assert len(source.intervals) == 3 and source.intervals[0].speaker_id == speaker.pk
    assert "private text" not in repr(source) and job.storage_name not in repr(source)
    assert source.expires_at is None


@pytest.mark.django_db
@pytest.mark.parametrize("version", ["server-version-1", None])
def test_direct_source_requires_a_version_shared_by_asr_and_identity(
    published, version
):
    actor, record, job, _ = published
    job.configuration["_identity_source"] = objects.ObjectReceipt(
        "s3_object",
        job.storage_name,
        job.size,
        etag='"opaque-token"',
        version_id=version,
    ).payload()
    job.save(update_fields=["configuration"])
    if version is None:
        with pytest.raises(VoiceprintError, match="source_integrity_unavailable"):
            sources.snapshot(record, actor, expected_revision=1)
    else:
        source = sources.snapshot(record, actor, expected_revision=1)
        assert sources.authorized(source) and source.receipt.version_id == version


@pytest.mark.django_db
@pytest.mark.parametrize(
    "damage",
    [
        "disabled",
        "suspended",
        "trashed",
        "reader",
        "revision",
        "unfinished",
        "count",
        "attempt",
        "no_diarization",
        "no_receipt",
        "changed_key",
        "changed_size",
        "changed_hash",
        "cleanup",
        "wrong_capture",
        "other_source",
        "invalid_times",
        "missing_times",
        "unknown",
        "invalid_speaker",
    ],
)
def test_source_authorization_and_publication_fail_closed(published, settings, damage):  # noqa: PLR0912 -- Each mutation independently exercises one fail-closed gate.
    actor, record, job, speaker = published
    if damage == "disabled":
        settings.MEETING_VOICEPRINT_MATCHING_ENABLED = False
    elif damage == "suspended":
        models.User.objects.filter(pk=actor.pk).update(is_active=False)
    elif damage == "trashed":
        models.MeetingRecord.objects.filter(pk=record.pk).update(
            deleted_at=timezone.now()
        )
    elif damage == "reader":
        actor = UserFactory()
        models.MeetingRecordAccess.objects.create(
            record=record, user=actor, read_transcript=True
        )
    elif damage == "revision":
        models.MeetingRecord.objects.filter(pk=record.pk).update(revision=2)
    elif damage == "unfinished":
        job.status = "running"
    elif damage in {"count", "attempt"}:
        job.configuration["_published"][
            "segment_count" if damage == "count" else "attempt"
        ] = 4
    elif damage == "no_diarization":
        job.configuration["diarization"] = False
    elif damage == "no_receipt":
        job.configuration.pop("_identity_source")
    elif damage == "changed_key":
        job.storage_name = "record-uploads/another.wav"
    elif damage == "changed_size":
        job.size += 1
    elif damage == "changed_hash":
        job.checksum = "b" * 64
    elif damage == "cleanup":
        models.CaptureAudioCleanup.objects.create(
            capture=job.capture, next_attempt_at=timezone.now()
        )
    elif damage == "wrong_capture":
        models.CaptureSession.objects.filter(pk=job.capture_id).update(
            created_by=UserFactory()
        )
    elif damage == "other_source":
        models.MeetingOriginalSegment.objects.filter(record=record).update(
            source_track_id="another-track"
        )
    elif damage == "invalid_times":
        models.MeetingOriginalSegment.objects.filter(record=record).update(
            end_ms=F("start_ms")
        )
    elif damage == "missing_times":
        models.MeetingOriginalSegment.objects.filter(record=record).update(end_ms=None)
    elif damage == "unknown":
        models.MeetingSpeaker.objects.filter(pk=speaker.pk).update(
            identity_type="unknown"
        )
    else:
        models.MeetingSpeaker.objects.filter(pk=speaker.pk).update(source_key="None")
    job.save()
    with pytest.raises(VoiceprintError):
        sources.snapshot(record, actor, expected_revision=1)


@pytest.mark.django_db
def test_text_only_original_window_is_not_extended(published):
    actor, record, job, _ = published
    models.MeetingRecord.objects.filter(pk=record.pk).update(retention_mode="text")
    source = sources.snapshot(record, actor, expected_revision=1)
    assert source.expires_at == job.capture.ended_at + timedelta(minutes=30)
    models.CaptureSession.objects.filter(pk=job.capture_id).update(
        started_at=timezone.now() - timedelta(hours=25)
    )
    assert not sources.authorized(source)
    with pytest.raises(VoiceprintError, match="media_expired"):
        sources.snapshot(record, actor, expected_revision=1)


@pytest.mark.django_db
def test_source_content_and_speaker_metadata_final_revalidation(published):
    actor, record, _, speaker = published
    source = sources.snapshot(record, actor, expected_revision=1)
    models.MeetingOriginalSegment.objects.filter(record=record).update(
        payload_hash="b" * 64
    )
    assert sources.authorized(source)  # Cheap live check; originals are immutable.
    assert not sources.revalidate(source)
    assert not sources.authorized(replace(source, actor_id=UserFactory().pk))
    models.MeetingSpeaker.objects.filter(pk=speaker.pk).update(source_key="1")
    assert not sources.revalidate(source)


@pytest.mark.django_db
def test_editor_needs_explicit_media_access_and_revocation_is_immediate(published):
    _, record, _, _ = published
    editor = UserFactory()
    grant = models.MeetingCollaborator.objects.create(
        record=record, scope="record", user=editor, role="editor", media=False
    )
    with pytest.raises(VoiceprintError, match="media_access_unavailable"):
        sources.snapshot(record, editor, expected_revision=1)
    models.MeetingCollaborator.objects.filter(pk=grant.pk).update(media=True)
    source = sources.snapshot(record, editor, expected_revision=1)
    assert sources.authorized(source)
    models.MeetingCollaborator.objects.filter(pk=grant.pk).update(role="reader")
    assert not sources.authorized(source) and not sources.revalidate(source)


@pytest.mark.django_db
@pytest.mark.parametrize("change", ["membership", "organization", "policy"])
def test_current_organization_authority_is_not_inferred_from_old_source(
    published, change
):
    actor, record, _, _ = published
    organization = OrganizationFactory(
        settings={"voiceprint": {"enabled": True, "version": 1}}
    )
    membership = MembershipFactory(user=actor, organization=organization)
    models.MeetingRecord.objects.filter(pk=record.pk).update(organization=organization)
    source = sources.snapshot(record, actor, expected_revision=1)
    if change == "membership":
        models.Membership.objects.filter(pk=membership.pk).update(status="inactive")
    elif change == "organization":
        models.Organization.objects.filter(pk=organization.pk).update(is_active=False)
    else:
        models.Organization.objects.filter(pk=organization.pk).update(
            settings={"voiceprint": {"enabled": False, "version": 2}}
        )
    assert not sources.authorized(source) and not sources.revalidate(source)
