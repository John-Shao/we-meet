"""Capture control recovery, scoped final ingestion and material permissions."""

import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import patch

from django.core.exceptions import ValidationError
from django.db import close_old_connections, transaction

import pytest
from rest_framework.test import APIClient

from core import models
from core.factories import MembershipFactory, OrganizationFactory, UserFactory
from core.services.meeting_captures import create_capture
from core.tests.services.test_meeting_records import client_for

pytestmark = pytest.mark.django_db
ROOT = "/api/v1.0/capture-sessions/"


@pytest.fixture(autouse=True)
def enabled(settings):
    settings.MEETING_RECORDS_ENABLED = True
    settings.MEETING_CAPTURE_PROTOCOL_ENABLED = True
    settings.AGENT_INTERNAL_API_TOKEN = "test-agent-only"


def create(user=None, body=None, key=None):
    user = user or UserFactory()
    body = body or {
        "device_id": "phone",
        "lease_key": str(uuid.uuid4()),
        "retention_mode": "text",
        "title": "访谈",
    }
    response = client_for(user).post(
        ROOT, body, format="json", HTTP_IDEMPOTENCY_KEY=str(key or uuid.uuid4())
    )
    assert response.status_code in (200, 201), response.data
    capture = models.CaptureSession.objects.get(pk=response.data["capture"]["id"])
    return user, body, capture, response


def command(  # noqa: PLR0913 -- exercise independent wire guards with one test helper
    user, body, capture, name, *, revision=None, key=None, lease=None, device=None
):
    capture.refresh_from_db()
    return client_for(user).post(
        f"{ROOT}{capture.pk}/commands/",
        {
            "command": name,
            "device_id": device or body["device_id"],
            "expected_revision": revision or capture.revision,
        },
        format="json",
        HTTP_IDEMPOTENCY_KEY=str(key or uuid.uuid4()),
        HTTP_X_CAPTURE_LEASE=lease or body["lease_key"],
    )


def grant(body, capture, track="mic", **overrides):
    capture.refresh_from_db()
    data = {
        "capture_id": str(capture.pk),
        "device_id": body["device_id"],
        "lease_key": body["lease_key"],
        "expected_revision": capture.revision,
        "source_track_id": track,
        **overrides,
    }
    return APIClient().post(
        "/api/agent/capture-writer-grants/",
        data,
        format="json",
        HTTP_X_AGENT_TOKEN="test-agent-only",
    )


def source(capture, sequence=1, **overrides):
    return {
        "record_id": str(capture.record_id),
        "capture_id": str(capture.pk),
        "ingest_id": str(uuid.uuid4()),
        "source_track_id": "mic",
        "source_sequence": sequence,
        "start_ms": (sequence - 1) * 1000,
        "end_ms": sequence * 1000,
        "speaker_key": "speaker-1",
        "speaker_label": "说话人 1",
        "identity_type": "diarized",
        "text": "需要确认负责人。",
        "language": "zh",
        "final": True,
        **overrides,
    }


def ingest(token, data, *, agent="test-agent-only"):
    return APIClient().post(
        "/api/agent/record-transcripts/",
        data,
        format="json",
        HTTP_X_AGENT_TOKEN=agent,
        HTTP_X_CAPTURE_WRITER=token,
    )


def recording():
    user, body, capture, _ = create()
    assert command(user, body, capture, "start").status_code == 200
    token = grant(body, capture).data["writer_grant"]
    return user, body, capture, token


def test_creation_replay_is_private_atomic_and_never_creates_room():
    user = UserFactory()
    org = OrganizationFactory()
    MembershipFactory(user=user, organization=org, is_primary=True)
    key = uuid.uuid4()
    _, body, capture, first = create(user, key=key)
    _, _, _, second = create(user, body, key)
    assert second.status_code == 200 and second.data["replayed"]
    assert first.data["operation_id"] == second.data["operation_id"]
    assert capture.record.organization_id == org.pk
    assert capture.record.owner_id == user.pk
    assert (
        not models.Room.objects.exists() and not models.MeetingSession.objects.exists()
    )
    assert (
        models.MeetingRecord.objects.count()
        == models.CaptureSession.objects.count()
        == 1
    )
    assert body["lease_key"] not in str(first.data)
    assert body["lease_key"] not in str(models.CaptureOperation.objects.get().payload)
    assert first["Cache-Control"] == "private, no-store"
    assert first.data["capture"]["captured_duration_ms"] is None
    assert first.data["capture"]["missing_ranges"] is None


def test_state_replay_returns_historical_receipt_and_current_state():
    user, body, capture, _ = create()
    key = uuid.uuid4()
    first = command(user, body, capture, "start", key=key)
    assert first.status_code == 200
    assert command(user, body, capture, "pause").status_code == 200
    replay = command(user, body, capture, "start", revision=1, key=key)
    assert replay.status_code == 200 and replay.data["replayed"]
    assert replay.data["result"]["status"] == "recording"
    assert replay.data["capture"]["status"] == "paused"
    assert replay.data["capture"]["revision"] == 3
    assert command(user, body, capture, "resume", revision=1).status_code == 409
    assert command(user, body, capture, "resume", key=key).status_code == 409


def test_lease_and_device_are_both_required_and_never_transfer_on_resume():
    user, body, capture, _ = recording()
    assert (
        command(user, body, capture, "pause", lease=str(uuid.uuid4())).status_code
        == 403
    )
    assert (
        command(user, body, capture, "pause", device="other-phone").status_code == 403
    )
    assert command(user, body, capture, "interrupt").status_code == 200
    assert (
        command(user, body, capture, "resume", device="other-phone").status_code == 403
    )
    assert command(user, body, capture, "resume").status_code == 200
    capture.refresh_from_db()
    assert capture.device_id == "phone"


def test_active_device_uniqueness_stop_finalize_and_fresh_capture():
    user, body, capture, _ = create()
    assert (
        client_for(user)
        .post(ROOT, body, format="json", HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()))
        .status_code
        == 409
    )
    assert models.MeetingRecord.objects.count() == 1
    assert command(user, body, capture, "finalize").status_code == 409
    assert command(user, body, capture, "stop").status_code == 200
    assert command(user, body, capture, "start").status_code == 409
    key = uuid.uuid4()
    capture.refresh_from_db()
    revision = capture.revision
    assert command(user, body, capture, "finalize", key=key).status_code == 200
    replay = command(user, body, capture, "finalize", revision=revision, key=key)
    assert replay.data["replayed"] and replay.data["capture"]["ended_at"]
    assert replay.data["capture"]["coverage_status"] == "unverified"
    _, _, other, _ = create(user, body)
    assert other.pk != capture.pk
    assert command(user, body, other, "start", key=key).status_code == 409


def test_readonly_grants_never_authorize_device_control_or_recovery():
    user, body, capture, token = recording()
    summary_reader, text_reader = UserFactory(), UserFactory()
    models.MeetingRecordAccess.objects.create(
        record=capture.record, user=summary_reader, read_summary=True
    )
    models.MeetingRecordAccess.objects.create(
        record=capture.record, user=text_reader, read_transcript=True
    )
    assert ingest(token, source(capture)).status_code == 201
    base = f"/api/v1.0/meeting-records/{capture.record_id}/"
    for reader in (summary_reader, text_reader, UserFactory()):
        assert client_for(reader).get(f"{ROOT}{capture.pk}/").status_code == 404
        assert command(reader, body, capture, "pause").status_code == 404
    for path in ("original-segments/", "speakers/"):
        assert client_for(summary_reader).get(base + path).status_code == 403
        assert client_for(text_reader).get(base + path).status_code == 200
        assert client_for(UserFactory()).get(base + path).status_code == 404
    state = client_for(user).get(f"{ROOT}{capture.pk}/")
    assert state.status_code == 200 and body["lease_key"] not in str(state.data)


def test_internal_credential_and_bound_track_capture_lease_are_required():
    user, body, capture, token = recording()
    data = source(capture)
    assert ingest(token, data, agent="").status_code == 403
    assert ingest(token + "tampered", data).status_code == 403
    assert grant(body, capture, lease_key=str(uuid.uuid4())).status_code == 403
    assert ingest(token, {**data, "source_track_id": "other-mic"}).status_code == 409
    _, _, other, _ = create()
    assert ingest(token, {**data, "capture_id": str(other.pk)}).status_code == 409
    assert ingest(token, {**data, "record_id": str(other.record_id)}).status_code == 409
    assert not models.MeetingOriginalSegment.objects.exists()


def test_grants_expire_and_all_control_revisions_fence_old_writers():
    user, body, capture, token = recording()
    data = source(capture)
    with patch("django.core.signing.time.time", return_value=99999999999):
        assert ingest(token, data).status_code == 403
    assert command(user, body, capture, "pause").status_code == 200
    assert ingest(token, data).status_code == 409
    paused_token = grant(body, capture).data["writer_grant"]
    assert ingest(paused_token, data).status_code == 201  # Authorized tail draining.
    assert command(user, body, capture, "interrupt").status_code == 200
    assert grant(body, capture).status_code == 409
    assert command(user, body, capture, "resume").status_code == 200
    renewed = grant(body, capture).data["writer_grant"]
    assert (
        ingest(renewed, data).status_code == 200
    )  # Same source/ingest ID after resume.
    assert command(user, body, capture, "stop").status_code == 200
    stop_token = grant(body, capture).data["writer_grant"]
    assert ingest(stop_token, source(capture, 2)).status_code == 201
    assert command(user, body, capture, "finalize").status_code == 200
    assert ingest(stop_token, source(capture, 3)).status_code == 409
    assert grant(body, capture).status_code == 409


def test_original_replay_conflicts_immutability_and_record_revision():
    _, _, capture, token = recording()
    data = source(capture)
    first = ingest(token, data)
    assert first.status_code == 201
    assert ingest(token, data).status_code == 200
    assert ingest(token, {**data, "text": "changed"}).status_code == 409
    assert ingest(token, {**data, "ingest_id": str(uuid.uuid4())}).status_code == 409
    capture.record.refresh_from_db()
    assert capture.record.revision == 2
    row = models.MeetingOriginalSegment.objects.get()
    row.text = "edited"
    with pytest.raises(ValidationError):
        row.save()
    speaker = models.MeetingSpeaker.objects.get()
    speaker.label = "another label"
    with pytest.raises(ValidationError):
        speaker.save()
    assert not models.Transcript.objects.exists()
    assert not models.MeetingMediaSegment.objects.exists()


def test_out_of_band_original_edit_cannot_receive_a_false_replay_ack():
    _, _, capture, token = recording()
    data = source(capture)
    assert ingest(token, data).status_code == 201
    models.MeetingOriginalSegment.objects.update(
        text="Changed outside the write service"
    )
    assert ingest(token, data).status_code == 409


def test_recovery_and_original_reads_are_bounded_and_paginated():
    user, _, capture, token = recording()
    assert ingest(token, source(capture)).status_code == 201
    speaker = models.MeetingSpeaker.objects.get()
    models.MeetingOriginalSegment.objects.bulk_create(
        [
            models.MeetingOriginalSegment(
                record=capture.record,
                capture_session=capture,
                speaker=speaker,
                ingest_id=uuid.uuid4(),
                source_track_id="mic",
                source_sequence=number,
                start_ms=number * 1000,
                end_ms=number * 1000 + 500,
                text=f"Segment {number}",
                language="zh",
                payload_hash="0" * 64,
            )
            for number in range(2, 206)
        ]
    )
    client = client_for(user)
    url = f"{ROOT}{capture.pk}/transcript-receipts/?source_track_id=mic"
    first = client.get(url).data
    assert len(first["results"]) == 200 and first["next_after_sequence"] == 200
    second = client.get(url + "&after_sequence=200").data
    assert len(second["results"]) == 5 and second["next_after_sequence"] is None
    url = f"/api/v1.0/meeting-records/{capture.record_id}/original-segments/"
    first = client.get(url).data
    assert len(first["results"]) == 30 and first["next_cursor"]
    second = client.get(url, {"cursor": first["next_cursor"]}).data
    assert len(second["results"]) == 30
    assert not {row["id"] for row in first["results"]} & {
        row["id"] for row in second["results"]
    }


@pytest.mark.django_db(transaction=True)
def test_concurrent_commands_cannot_both_advance_one_revision():
    user, body, capture, _ = recording()
    revision = capture.revision
    barrier = Barrier(2)

    def run(name):
        close_old_connections()
        try:
            local_user = models.User.objects.get(pk=user.pk)
            local_capture = models.CaptureSession.objects.get(pk=capture.pk)
            barrier.wait(timeout=10)
            return command(
                local_user, body, local_capture, name, revision=revision
            ).status_code
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(run, name) for name in ("pause", "interrupt")]
        results = [f.result(timeout=20) for f in futures]
    assert sorted(results) == [200, 409]
    capture.refresh_from_db()
    assert capture.revision == revision + 1


def test_speakers_are_source_scoped_and_never_map_to_an_account():
    _, body, capture, token = recording()
    assert ingest(token, source(capture)).status_code == 201
    assert (
        ingest(token, source(capture, 2, speaker_label="different person")).status_code
        == 409
    )
    second = grant(body, capture, track="second-mic").data["writer_grant"]
    assert (
        ingest(second, source(capture, source_track_id="second-mic")).status_code == 201
    )
    _, _, other, other_token = recording()
    assert ingest(other_token, source(other)).status_code == 201
    assert models.MeetingSpeaker.objects.count() == 3
    assert all(
        s.identity_type == "diarized" and not hasattr(s, "user_id")
        for s in models.MeetingSpeaker.objects.all()
    )


@pytest.mark.parametrize(
    "change",
    [
        {"final": False},
        {"text": "  "},
        {"text": "x" * 20001},
        {"end_ms": -1},
        {"start_ms": 5, "end_ms": 4},
        {"source_sequence": 0},
        {"identity_type": "authenticated"},
        {"user_id": str(uuid.uuid4())},
        {"room_id": str(uuid.uuid4())},
    ],
)
def test_original_input_validation_rejects_partial_or_invented_identity(change):
    _, _, capture, token = recording()
    assert ingest(token, source(capture, **change)).status_code == 400
    assert not models.MeetingOriginalSegment.objects.exists()


def test_native_reads_preserve_gaps_and_recovery_never_reports_audio_ack():
    user, _, capture, token = recording()
    first, third = source(capture), source(capture, 3, start_ms=20000, end_ms=None)
    assert ingest(token, third).status_code == 201
    assert ingest(token, first).status_code == 201
    url = f"{ROOT}{capture.pk}/transcript-receipts/?source_track_id=mic"
    response = client_for(user).get(url)
    assert [row["source_sequence"] for row in response.data["results"]] == [1, 3]
    assert "text" not in str(response.data)
    assert response.data["coverage_status"] == "unverified"
    assert len(client_for(user).get(url + "&after_sequence=1").data["results"]) == 1
    base = f"/api/v1.0/meeting-records/{capture.record_id}/original-segments/"
    originals = client_for(user).get(base).data["results"]
    assert [row["start_ms"] for row in originals] == [0, 20000]
    assert originals[1]["end_ms"] is None
    assert (
        client_for(user).get(base + f"?speaker_id={uuid.uuid4()}").data["results"] == []
    )
    capture.refresh_from_db()
    assert capture.last_acked_sequence == capture.captured_duration_ms == 0


def test_membership_and_account_revocation_invalidate_existing_grant_and_replays():
    user = UserFactory()
    membership = MembershipFactory(user=user, organization=OrganizationFactory())
    key = uuid.uuid4()
    _, body, capture, _ = create(user, key=key)
    assert command(user, body, capture, "start").status_code == 200
    token = grant(body, capture).data["writer_grant"]
    membership.delete()
    assert ingest(token, source(capture)).status_code == 403
    assert client_for(user).get(f"{ROOT}{capture.pk}/").status_code == 404
    assert (
        client_for(user)
        .post(ROOT, body, format="json", HTTP_IDEMPOTENCY_KEY=str(key))
        .status_code
        == 403
    )
    # A fresh personal capture still must reject an account deactivated after grant issuance.
    _, _, personal, personal_token = recording()
    models.User.objects.filter(pk=personal.created_by_id).update(is_active=False)
    assert ingest(personal_token, source(personal)).status_code == 403


def test_flags_validation_and_missing_auth(settings):
    user, body, capture, _ = create()
    client = client_for(user)
    assert APIClient().get(f"{ROOT}{capture.pk}/").status_code in (401, 403)
    assert client.post(ROOT, body, format="json").status_code == 400
    assert (
        client.post(
            ROOT,
            {**body, "organization_id": str(uuid.uuid4())},
            format="json",
            HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
        ).status_code
        == 400
    )
    assert (
        client.post(
            ROOT,
            {**body, "lease_key": str(uuid.uuid1())},
            format="json",
            HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()),
        ).status_code
        == 400
    )
    settings.MEETING_CAPTURE_PROTOCOL_ENABLED = False
    assert client.get(f"{ROOT}{capture.pk}/").status_code == 200
    assert client.post(ROOT, body, format="json").status_code == 404
    assert grant(body, capture).status_code == 404
    assert (
        client.get(
            f"/api/v1.0/meeting-records/{capture.record_id}/speakers/"
        ).status_code
        == 404
    )


def test_rollback_does_not_leave_private_note_or_control_receipt():
    user = UserFactory()
    data = {
        "device_id": "phone",
        "lease_key": str(uuid.uuid4()),
        "retention_mode": "text",
        "title": "",
    }
    with pytest.raises(RuntimeError), transaction.atomic():
        create_capture(user, uuid.uuid4(), data)
        raise RuntimeError("rollback")
    assert not models.MeetingRecord.objects.exists()
    assert not models.CaptureOperation.objects.exists()


@pytest.mark.django_db(transaction=True)
def test_concurrent_creation_same_key_has_one_note_and_receipt():
    user = UserFactory()
    key = uuid.uuid4()
    data = {
        "device_id": "phone",
        "lease_key": str(uuid.uuid4()),
        "retention_mode": "text",
        "title": "",
    }
    barrier = Barrier(2)

    def run():
        close_old_connections()
        try:
            local_user = models.User.objects.get(pk=user.pk)
            barrier.wait(timeout=10)
            receipt, replay = create_capture(local_user, key, data)
            return receipt.pk, replay
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(run) for _ in range(2)]
        results = [f.result(timeout=20) for f in futures]
    assert results[0][0] == results[1][0]
    assert sorted(row[1] for row in results) == [False, True]
    assert (
        models.MeetingRecord.objects.count()
        == models.CaptureOperation.objects.count()
        == 1
    )
