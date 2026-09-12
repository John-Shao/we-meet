"""Record provenance, access boundaries, recovery and migration regression tests."""

import io
import json
from datetime import timedelta

from django.core.exceptions import ValidationError
from django.core.management import call_command
from django.db import IntegrityError, transaction
from django.utils import timezone

import pytest
from rest_framework.test import APIClient

from core import models
from core.factories import (
    MeetingParticipationFactory,
    MeetingSessionFactory,
    MembershipFactory,
    OrganizationFactory,
    RecordingFactory,
    RoomFactory,
    UserFactory,
)
from core.services.meeting_records import (
    RecordConflict,
    enqueue_job,
    ensure_online_record,
    retry_job,
    transition_job,
    visible_records,
)

pytestmark = pytest.mark.django_db


def online_note(user=None, room=None, text="first meeting"):
    """Create one ended session with an original final utterance."""
    user = user or UserFactory()
    room = room or RoomFactory(users=[(user, models.RoleChoices.OWNER)])
    started = timezone.now() - timedelta(hours=1)
    session = MeetingSessionFactory(
        room=room,
        started_at=started,
        status="ended",
        ended_at=started + timedelta(minutes=30),
        end_reason="room_finished",
    )
    transcript = models.Transcript.objects.create(
        room=room,
        session=session,
        speaker_identity=str(user.pk),
        speaker_name="Speaker",
        text=text,
        started_at=started,
    )
    record, _ = ensure_online_record(session)
    return user, session, transcript, record


def audio_note(user=None, organization=None):
    """Independent recording has no Room or MeetingSession."""
    return models.MeetingRecord.objects.create(
        owner=user or UserFactory(),
        organization=organization,
        source_type="audio_recording",
        title="Offline interview",
        origin_at=timezone.now(),
        retention_mode="media",
    )


def client_for(user):
    """Authenticate without calling external identity services."""
    client = APIClient()
    client.force_authenticate(user)
    return client


def test_projection_is_idempotent_and_keeps_two_sessions_separate():
    user, first, _, record = online_note()
    repeated, created = ensure_online_record(first)
    _, second, _, other = online_note(user=user, room=first.room, text="second meeting")
    assert not created and repeated.pk == record.pk
    assert other.pk != record.pk and other.source_session_id == second.pk
    assert models.MeetingRecord.objects.count() == 2


def test_empty_meeting_does_not_create_note():
    with pytest.raises(RecordConflict):
        ensure_online_record(MeetingSessionFactory())
    assert not models.MeetingRecord.objects.exists()


def test_source_and_organization_cannot_be_reassigned():
    _, session, _, record = online_note()
    other = MeetingSessionFactory()
    record.meeting_session = other
    record.source_session_id = other.pk
    with pytest.raises(ValidationError):
        record.save()
    record.refresh_from_db()
    record.organization = OrganizationFactory()
    with pytest.raises(ValidationError):
        record.save()
    assert session.pk == record.source_session_id


def test_database_rejects_cross_session_binding_even_when_clean_is_bypassed():
    _, _, _, record = online_note()
    other = MeetingSessionFactory()
    with pytest.raises(IntegrityError), transaction.atomic():
        models.MeetingRecord.objects.filter(pk=record.pk).update(meeting_session=other)


def test_room_deletion_preserves_record_provenance_without_granting_access():
    user, session, _, record = online_note()
    original = session.pk
    session.room.delete()
    record.refresh_from_db()
    assert record.meeting_session_id is None
    assert record.source_session_id == original
    assert not visible_records(user).exists()


def test_independent_capture_does_not_need_a_room_and_enforces_device_exclusivity():
    record = audio_note()
    kwargs = {
        "record": record,
        "created_by": record.owner,
        "device_id": "device-a",
        "started_at": timezone.now(),
    }
    first = models.CaptureSession.objects.create(**kwargs)
    assert first.record.meeting_session_id is None
    with pytest.raises(ValidationError):
        models.CaptureSession.objects.create(**kwargs)
    other = audio_note(user=record.owner)
    with pytest.raises(ValidationError):
        models.CaptureSession.objects.create(**{**kwargs, "record": other})


def test_capture_cannot_be_assigned_to_another_owner_or_online_meeting():
    record = audio_note()
    with pytest.raises(ValidationError):
        models.CaptureSession.objects.create(
            record=record,
            created_by=UserFactory(),
            device_id="a",
            started_at=timezone.now(),
        )
    user, _, _, online = online_note()
    with pytest.raises(ValidationError):
        models.CaptureSession.objects.create(
            record=online, created_by=user, device_id="a", started_at=timezone.now()
        )


def test_media_cannot_link_a_recording_from_another_session():
    _, session, _, record = online_note()
    foreign_session = MeetingSessionFactory()
    foreign = RecordingFactory(room=foreign_session.room, session=foreign_session)
    with pytest.raises(ValidationError):
        models.MeetingMediaSegment.objects.create(
            record=record, recording=foreign, sequence=1, record_start_ms=0
        )
    recording = RecordingFactory(room=session.room, session=session)
    segment = models.MeetingMediaSegment.objects.create(
        record=record,
        recording=recording,
        sequence=1,
        record_start_ms=5000,
        duration_ms=1000,
    )
    assert segment.record_start_ms == 5000


def test_capture_stop_requires_an_end_time():
    record = audio_note()
    with pytest.raises(ValidationError):
        models.CaptureSession.objects.create(
            record=record,
            created_by=record.owner,
            device_id="a",
            started_at=timezone.now(),
            status="stopped",
        )


def test_attendance_and_public_room_do_not_grant_material_access():
    _, session, _, record = online_note()
    outsider = UserFactory()
    session.room.access_level = models.RoomAccessLevel.PUBLIC
    session.room.save()
    MeetingParticipationFactory(session=session, user=outsider)
    assert not visible_records(outsider).filter(pk=record.pk).exists()


def test_membership_and_explicit_grant_are_both_required_for_org_record():
    org = OrganizationFactory()
    member = MembershipFactory(organization=org).user
    outsider = MembershipFactory().user
    record = audio_note(organization=org)
    assert not visible_records(member).exists()
    models.MeetingRecordAccess.objects.create(
        record=record, user=member, read_summary=True
    )
    models.MeetingRecordAccess.objects.create(
        record=record, user=outsider, read_summary=True
    )
    assert visible_records(member).filter(pk=record.pk).exists()
    assert not visible_records(outsider).exists()
    models.Membership.objects.filter(user=member).update(status="suspended")
    assert not visible_records(member).exists()


def test_api_is_disabled_by_default(settings):
    user, _, _, record = online_note()
    settings.MEETING_RECORDS_ENABLED = False
    assert (
        client_for(user).get(f"/api/v1.0/meeting-records/{record.pk}/").status_code
        == 404
    )


def test_summary_only_share_cannot_read_transcripts(settings):
    settings.MEETING_RECORDS_ENABLED = True
    _, _, _, record = online_note()
    reader = UserFactory()
    models.MeetingRecordAccess.objects.create(
        record=record, user=reader, read_summary=True
    )
    client = client_for(reader)
    detail = client.get(f"/api/v1.0/meeting-records/{record.pk}/")
    assert detail.status_code == 200
    assert detail.json()["capabilities"]["read_transcript"] is False
    assert (
        client.get(f"/api/v1.0/meeting-records/{record.pk}/transcripts/").status_code
        == 403
    )
    assert client.get(f"/api/v1.0/meeting-records/{record.pk}/summaries/").json() == {
        "results": []
    }


def test_record_api_reads_exact_session_and_rechecks_revoked_access(settings):
    settings.MEETING_RECORDS_ENABLED = True
    user, session, transcript, record = online_note()
    online_note(user=user, room=session.room, text="must not leak into first session")
    client = client_for(user)
    response = client.get(f"/api/v1.0/meeting-records/{record.pk}/transcripts/")
    assert response.status_code == 200
    assert [r["id"] for r in response.json()["results"]] == [str(transcript.pk)]
    # Keep another owner so revocation respects the existing Room invariant.
    models.ResourceAccess.objects.create(
        resource=session.room, user=UserFactory(), role=models.RoleChoices.OWNER
    )
    models.ResourceAccess.objects.filter(resource=session.room, user=user).delete()
    assert client.get(f"/api/v1.0/meeting-records/{record.pk}/").status_code == 404


def test_api_title_filter_and_pagination_do_not_include_other_users(settings):
    settings.MEETING_RECORDS_ENABLED = True
    own = audio_note()
    audio_note()
    response = client_for(own.owner).get("/api/v1.0/meeting-records/?q=interview")
    assert response.status_code == 200
    assert [r["id"] for r in response.json()["results"]] == [str(own.pk)]
    assert response.json()["next_cursor"] is None


def test_new_committed_material_projects_only_when_enabled(
    settings, django_capture_on_commit_callbacks
):
    settings.MEETING_RECORDS_ENABLED = True
    session = MeetingSessionFactory()
    with django_capture_on_commit_callbacks(execute=True):
        RecordingFactory(room=session.room, session=session)
    assert models.MeetingRecord.objects.filter(meeting_session=session).count() == 1


def test_backfill_is_dry_by_default_idempotent_and_reports_unresolved():
    session = MeetingSessionFactory()
    RecordingFactory(room=session.room, session=session)
    RecordingFactory()

    def run(*args):
        output = io.StringIO()
        call_command("backfill_meeting_records", *args, stdout=output)
        return json.loads(output.getvalue())

    assert run()["eligible_sessions"] == 1
    assert not models.MeetingRecord.objects.exists()
    first = run("--apply")
    assert first["created"] == 1 and first["unresolved"]["Recording"] == 1
    assert run("--apply")["created"] == 0


def test_old_generation_and_canceled_workers_cannot_overwrite_new_jobs():
    record = audio_note()
    first, created = enqueue_job(record.pk, "summary", input_revision=1)
    again, duplicate = enqueue_job(record.pk, "summary", input_revision=1)
    assert created and not duplicate and again.pk == first.pk
    transition_job(first.pk, attempt=1, target="running")
    second, _ = enqueue_job(record.pk, "summary", input_revision=1, regenerate=True)
    with pytest.raises(RecordConflict):
        transition_job(first.pk, attempt=1, target="succeeded", result={"old": True})
    transition_job(second.pk, attempt=1, target="running")
    transition_job(second.pk, attempt=1, target="succeeded", result={"new": True})
    first.refresh_from_db()
    assert first.status == "canceled"


def test_retry_rejects_late_attempt_and_changed_input():
    record = audio_note()
    job, _ = enqueue_job(record.pk, "summary", input_revision=1)
    transition_job(job.pk, attempt=1, target="running")
    transition_job(
        job.pk,
        attempt=1,
        target="failed",
        error_code="upstream_timeout",
        retryable=True,
    )
    retried = retry_job(job.pk)
    assert retried.attempt == 2
    with pytest.raises(RecordConflict):
        transition_job(job.pk, attempt=1, target="succeeded")
    record.revision = 2
    record.save()
    with pytest.raises(RecordConflict):
        transition_job(job.pk, attempt=2, target="running")


def test_document_failure_does_not_change_summary_job():
    record = audio_note()
    summary, _ = enqueue_job(record.pk, "summary", input_revision=1)
    document, _ = enqueue_job(record.pk, "doc", input_revision=1)
    transition_job(summary.pk, attempt=1, target="running")
    transition_job(summary.pk, attempt=1, target="succeeded")
    transition_job(document.pk, attempt=1, target="running")
    transition_job(document.pk, attempt=1, target="failed", retryable=True)
    summary.refresh_from_db()
    assert summary.status == "succeeded"


def test_room_organization_change_invalidates_even_explicit_grants():
    user, session, _, record = online_note()
    models.MeetingRecordAccess.objects.create(
        record=record, user=user, read_summary=True
    )
    models.Room.objects.filter(pk=session.room_id).update(
        organization=OrganizationFactory()
    )
    assert not visible_records(user).filter(pk=record.pk).exists()


def test_summary_projection_preserves_manual_content_and_session(settings):
    settings.MEETING_RECORDS_ENABLED = True
    user, session, _, record = online_note()
    models.Summary.objects.create(
        room=session.room,
        session=session,
        content="AI draft",
        edited_content="Reviewed decision",
        status="success",
    )
    _, second, _, _ = online_note(user=user, room=session.room)
    models.Summary.objects.create(
        room=session.room, session=second, content="Other meeting", status="success"
    )
    response = client_for(user).get(f"/api/v1.0/meeting-records/{record.pk}/summaries/")
    assert response.status_code == 200
    assert response.json()["results"][0]["content"] == "Reviewed decision"
    assert response.json()["results"][0]["session_id"] == str(session.pk)
    assert response["Cache-Control"] == "private, no-store"


def test_transcript_cursor_handles_simultaneous_utterances(settings):
    settings.MEETING_RECORDS_ENABLED = True
    user, session, first, record = online_note()
    for i in range(31):
        models.Transcript.objects.create(
            room=session.room,
            session=session,
            speaker_identity="speaker",
            speaker_name="Speaker",
            text=f"line {i}",
            started_at=first.started_at,
        )
    client = client_for(user)
    url = f"/api/v1.0/meeting-records/{record.pk}/transcripts/"
    first_page = client.get(url).json()
    second_page = client.get(url, {"cursor": first_page["next_cursor"]}).json()
    assert len(first_page["results"]) == 30
    assert len(second_page["results"]) == 2
    assert second_page["next_cursor"] is None
    assert len({r["id"] for r in first_page["results"] + second_page["results"]}) == 32


def test_read_api_rejects_mutations_and_invalid_filters(settings):
    settings.MEETING_RECORDS_ENABLED = True
    record = audio_note()
    client = client_for(record.owner)
    assert client.post("/api/v1.0/meeting-records/", {}).status_code == 405
    assert (
        client.get("/api/v1.0/meeting-records/?source_type=invalid").status_code == 400
    )
    assert (
        client.get("/api/v1.0/meeting-records/?meeting_session_id=invalid").status_code
        == 400
    )


def test_rolled_back_or_disabled_material_does_not_project(
    settings, django_capture_on_commit_callbacks
):
    session = MeetingSessionFactory()
    settings.MEETING_RECORDS_ENABLED = False
    with django_capture_on_commit_callbacks(execute=True):
        RecordingFactory(room=session.room, session=session)
    assert not models.MeetingRecord.objects.exists()
    settings.MEETING_RECORDS_ENABLED = True
    with django_capture_on_commit_callbacks(execute=True):
        with transaction.atomic():
            other_session = MeetingSessionFactory()
            RecordingFactory(room=other_session.room, session=other_session)
            transaction.set_rollback(True)
    assert not models.MeetingRecord.objects.exists()
