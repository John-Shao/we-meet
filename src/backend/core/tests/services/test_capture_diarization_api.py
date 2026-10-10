"""Owner API commands and capture identity proofs; synthetic audio only."""

import json
from dataclasses import replace
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

from django.core.cache import cache
from django.core.files.storage import default_storage
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

import pytest

from core import models
from core.factories import UserFactory
from core.services import capture_diarization as control
from core.services import capture_diarization_commands as commands
from core.services import capture_diarization_inputs as inputs
from core.services import capture_diarization_objects as objects
from core.services import capture_diarization_worker as worker
from core.services import (
    capture_voiceprint_sources,
    speaker_identification,
    speaker_identity_jobs,
    voiceprint_sources,
)
from core.services.voiceprint_consent import VoiceprintError
from core.services.voiceprint_query_producer import ProducedQuery, check_storage
from core.services.voiceprint_source_storage import from_storage
from core.tests.services.test_capture_audio import recording, seal, upload
from core.tests.services.test_capture_diarization import enabled as capture_enabled
from core.tests.services.test_capture_diarization import prepare, source
from core.tests.services.test_capture_diarization_worker import (
    pipeline,
    ready,
    result,
    worker_options,
)
from core.tests.services.test_capture_transcription import (
    agent,
    claim,
    final,
    request_job,
)
from core.tests.services.test_capture_transcription import control as asr_control
from core.tests.services.test_meeting_captures import command
from core.tests.services.test_meeting_records import client_for
from core.tests.services.test_speaker_identification import decide
from core.tests.services.test_voiceprint_candidates import matching_enabled, register
from core.tests.services.test_voiceprint_consent import enabled as voiceprint_enabled
from core.tests.test_services_capture_diarization_pcm import audio, private_s3
from core.tests.test_services_voiceprint_matching import clips

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def enabled(capture_enabled, voiceprint_enabled):
    cache.clear()


def path(capture):
    return f"/api/v1.0/capture-sessions/{capture.pk}/diarization/"


def post(owner, capture, *, key=None, **changes):
    capture.record.refresh_from_db()
    return client_for(owner).post(
        path(capture),
        {"expected_revision": capture.record.revision, **changes},
        format="json",
        HTTP_IDEMPOTENCY_KEY=str(key or uuid4()),
        HTTP_X_VOICEPRINT_OWNER=str(owner.pk),
    )


def test_public_submission_is_one_receipt_and_never_performs_private_or_paid_io(
    monkeypatch, settings
):
    owner, capture, _ = source()
    submit = Mock(side_effect=AssertionError("No paid I/O in an HTTP view"))
    monkeypatch.setattr(worker.provider, "submit", submit)
    key = uuid4()
    first = post(owner, capture, key=key)
    assert first.status_code == 201, first.data
    assert first.data["command_receipt"] == {
        "key": str(key),
        "scope": {"capture_id": str(capture.pk)},
    }
    settings.MEETING_CAPTURE_DIARIZATION_ENABLED = False
    replay = post(owner, capture, key=key)
    assert replay.status_code == 200 and not replay.data["created"]
    assert replay.data["job"]["id"] == first.data["job"]["id"]
    assert post(owner, capture).status_code == 503
    assert first["Cache-Control"] == "private, no-store"
    assert models.CaptureDiarizationJob.objects.count() == 1
    assert not models.CaptureDiarizationInput.objects.exists()
    submit.assert_not_called()


@pytest.mark.parametrize(
    "change",
    [
        {"expected_revision": True},
        {"expected_revision": "1"},
        {"expected_revision": 1.0},
        {"provider_task_id": "forged"},
        {"turns": []},
    ],
)
def test_submission_rejects_non_integer_revision_and_provider_fields(change):
    owner, capture, _ = source()
    assert post(owner, capture, **change).status_code == 400
    assert not models.CaptureDiarizationJob.objects.exists()


def test_command_and_read_require_current_owner_and_account_header():
    owner, capture, _ = source()
    stranger = UserFactory()
    assert client_for(stranger).get(path(capture)).status_code == 404
    assert post(stranger, capture).status_code == 404
    response = client_for(owner).get(
        path(capture), HTTP_X_VOICEPRINT_OWNER=str(stranger.pk)
    )
    assert response.status_code == 401
    assert not models.CaptureDiarizationJob.objects.exists()


def test_state_is_bounded_private_and_does_not_fetch_audio(private_s3, monkeypatch):
    owner, capture, _, job, _ = pipeline(private_s3, monkeypatch)
    worker.process(job.pk)
    monkeypatch.setattr(
        objects, "verify", Mock(side_effect=AssertionError("Read is metadata only"))
    )
    state = client_for(owner).get(path(capture))
    assert state.status_code == 200 and not state.data["can_start"]
    serialized = json.dumps(state.data)
    assert all(
        value not in serialized
        for value in [
            "fixed-version",
            "synthetic-task",
            "identity-input",
            "source_fingerprint",
            "provider_report",
            "inputs",
            "worker_id",
        ]
    )
    assert state["Cache-Control"] == "private, no-store"
    assert (
        client_for(owner).get(path(capture), {"provider": "forged"}).status_code == 400
    )


def test_cancel_stops_local_work_retains_late_paid_receipt_and_schedules_erasure(
    private_s3, monkeypatch, settings
):
    owner, capture, _, job, submit = pipeline(private_s3, monkeypatch)
    identifier = uuid4()
    claimed = control.claim(job.pk, identifier)
    inputs.prepare(claimed, identifier, authorized=lambda: worker.live(claimed))
    worker.begin(job.pk, identifier)
    settings.MEETING_CAPTURE_DIARIZATION_ENABLED = False
    url = path(capture) + f"{job.pk}/cancel/"
    response = client_for(owner).post(
        url, {"expected_revision": capture.record.revision}, format="json"
    )
    assert response.status_code == 200, response.data
    assert response.data["job"]["status"] == "canceled"
    assert (
        client_for(owner)
        .post(url, {"expected_revision": capture.record.revision}, format="json")
        .status_code
        == 200
    )
    worker.acknowledge(job.pk, identifier, "late-task")
    job.refresh_from_db()
    assert (
        job.status == "canceled"
        and job.phase == "canceled"
        and job.provider_task_id == "late-task"
    )
    row = job.media_inputs.get()
    models.CaptureDiarizationInput.objects.filter(pk=row.pk).update(
        write_until=timezone.now() - timedelta(seconds=1)
    )
    assert row.pk in inputs.due()
    assert not job.originals.exists()
    submit.assert_not_called()


def test_cancel_cannot_target_another_capture_or_stale_revision():
    owner, capture, _ = source()
    job = prepare(owner, capture)
    assert (
        client_for(owner)
        .post(
            path(capture) + f"{job.pk}/cancel/",
            {"expected_revision": capture.record.revision + 1},
            format="json",
        )
        .status_code
        == 409
    )
    assert (
        client_for(owner)
        .post(
            path(capture) + f"{uuid4()}/cancel/",
            {"expected_revision": capture.record.revision},
            format="json",
        )
        .status_code
        == 404
    )
    job.refresh_from_db()
    assert job.status == "queued"


def published(state, monkeypatch, *, timed=True, text=False):
    owner, capture, _, job, submit = pipeline(
        state, monkeypatch, text=text, timed=timed
    )
    enable_library(capture)
    monkeypatch.setattr(worker.provider, "poll", Mock(return_value=result()))
    worker.process(job.pk)
    ready(job)
    worker.process(job.pk)
    job.refresh_from_db()
    assert job.status == "succeeded", job.error_code
    capture.record.refresh_from_db()
    capture.refresh_from_db()
    return owner, capture, job, submit


def enable_library(capture):
    organization = capture.record.organization
    if organization:
        organization.settings = {
            **organization.settings,
            "voiceprint": {"enabled": True, "version": 1},
        }
        organization.save(update_fields=["settings"])


def test_capture_snapshot_binds_the_published_version_and_clean_intervals(
    private_s3, monkeypatch
):
    owner, capture, job, _ = published(private_s3, monkeypatch)
    snapshot = voiceprint_sources.snapshot(
        capture.record, owner, expected_revision=capture.record.revision
    )
    assert (
        snapshot.storage_kind == "capture"
        and snapshot.receipt.version_id == "fixed-version"
    )
    assert snapshot.media_sha256 == job.input.sha256
    assert {row.speaker_id for row in snapshot.intervals} == set(
        job.originals.values_list("speaker_id", flat=True)
    )
    assert voiceprint_sources.authorized(snapshot) and voiceprint_sources.revalidate(
        snapshot
    )
    check_storage(snapshot, from_storage(private_s3.storage))
    with pytest.raises(VoiceprintError, match="storage_changed"):
        check_storage(
            snapshot, replace(from_storage(private_s3.storage), bucket="other-bucket")
        )


def test_ambiguous_recorded_sentence_is_not_a_whole_recording_identity_target(
    private_s3, monkeypatch
):
    owner, capture, _, _ = published(private_s3, monkeypatch, timed=False)
    with pytest.raises(VoiceprintError, match="diarization_unavailable"):
        voiceprint_sources.snapshot(
            capture.record, owner, expected_revision=capture.record.revision
        )


@pytest.mark.parametrize(
    "change", ["version", "asr", "missing", "payload", "source", "retention"]
)
def test_capture_identity_rejects_stale_or_changed_generation(
    private_s3, monkeypatch, change
):
    owner, capture, job, _ = published(private_s3, monkeypatch)
    snapshot = voiceprint_sources.snapshot(
        capture.record, owner, expected_revision=capture.record.revision
    )
    if change == "version":
        models.CaptureSession.objects.filter(pk=capture.pk).update(
            active_diarization=None
        )
    elif change == "asr":
        models.CaptureSession.objects.filter(pk=capture.pk).update(
            active_transcription=None
        )
    elif change == "missing":
        job.originals.all().delete()
    elif change == "payload":
        job.originals.update(text="tampered source")
    elif change == "source":
        models.CaptureDiarizationJob.objects.filter(pk=job.pk).update(
            source_fingerprint="b" * 64
        )
    else:
        models.MeetingRecord.objects.filter(pk=capture.record_id).update(
            retention_mode="text"
        )
    assert not voiceprint_sources.revalidate(snapshot)


def test_text_snapshot_expires_with_the_selected_input_even_with_media_metadata_remaining(
    private_s3, monkeypatch
):
    owner, capture, job, _ = published(private_s3, monkeypatch, text=True)
    snapshot = voiceprint_sources.snapshot(
        capture.record, owner, expected_revision=capture.record.revision
    )
    models.CaptureDiarizationInput.objects.filter(pk=job.input_id).update(
        expires_at=timezone.now() - timedelta(seconds=1)
    )
    assert not voiceprint_sources.authorized(snapshot)
    assert not voiceprint_sources.revalidate(snapshot)


def test_capture_header_does_not_load_large_frozen_inputs_on_repeated_authority_checks(
    private_s3, monkeypatch
):
    owner, capture, job, _ = published(private_s3, monkeypatch)
    evidence = voiceprint_sources.header(
        capture.record_id, owner.pk, capture.record.revision
    )
    assert "inputs" in evidence[1].get_deferred_fields()
    # Source snapshots perform the complete proof once and before publication.
    assert voiceprint_sources.snapshot(
        capture.record, owner, expected_revision=capture.record.revision
    ).media_sha256


@pytest.mark.parametrize("budget", ["proof", "derivation"])
def test_capture_identity_rejects_oversized_proofs_before_hydrating_rows(
    private_s3, monkeypatch, budget
):
    owner, capture, _, _ = published(private_s3, monkeypatch)
    if budget == "proof":
        monkeypatch.setattr(capture_voiceprint_sources, "MAX_PROOF_BYTES", 1)
        monkeypatch.setattr(
            capture_voiceprint_sources,
            "digest",
            Mock(side_effect=AssertionError("Frozen proof must not be loaded")),
        )
    else:
        monkeypatch.setattr(control, "MAX_DERIVATION_BYTES", 1)
        monkeypatch.setattr(
            capture_voiceprint_sources,
            "validate_publication",
            Mock(side_effect=AssertionError("Derived rows must not be loaded")),
        )
    with pytest.raises(VoiceprintError, match="generation_unavailable"):
        voiceprint_sources.snapshot(
            capture.record, owner, expected_revision=capture.record.revision
        )


def test_capture_command_state_admits_real_audio_enum_and_stops_at_daily_budget(
    settings,
):
    owner, capture, _ = source()
    state = client_for(owner).get(path(capture))
    assert state.status_code == 200 and state.data["can_start"]
    job = post(owner, capture).data["job"]
    assert (
        client_for(owner)
        .post(
            path(capture) + f"{job['id']}/cancel/",
            {"expected_revision": capture.record.revision},
            format="json",
        )
        .status_code
        == 200
    )
    assert client_for(owner).get(path(capture)).data["can_start"]
    settings.MEETING_CAPTURE_DIARIZATION_DAILY_LIMIT = 1
    assert not client_for(owner).get(path(capture)).data["can_start"]


def long_published(state, monkeypatch):
    owner, body, capture = recording()
    for index in range(3):
        assert (
            upload(
                owner,
                body,
                capture,
                data=audio(milliseconds=10000),
                sequence=index + 1,
                start_ms=index * 10000,
            ).status_code
            == 200
        )
    assert command(owner, body, capture, "stop").status_code == 200
    assert seal(owner, body, capture, 3).status_code == 200
    assert command(owner, body, capture, "finalize").status_code == 200
    assert request_job(owner, capture).status_code == 201
    identifier, asr = claim()
    assert asr_control(asr["id"], identifier, "begin").status_code == 200
    for index, chunk in enumerate(asr["inputs"]["chunks"], 1):
        assert (
            asr_control(
                asr["id"],
                identifier,
                "ack_input",
                index=index,
                checksum=chunk["checksum"],
            ).status_code
            == 200
        )
        assert (
            final(
                asr["id"],
                identifier,
                sequence=index,
                start_ms=(index - 1) * 10000,
                end_ms=index * 10000,
            )[0].status_code
            == 201
        )
    finished = agent(
        f"{asr['id']}/finish/",
        {
            "worker_id": str(identifier),
            "provider_finished": True,
            "final_sequence": 3,
            "tasks": [
                {
                    "task_id": str(uuid4()),
                    "finished": True,
                    "input_samples": 480000,
                    "billed_seconds": None,
                }
                for _ in range(1)
            ],
        },
    )
    assert finished.status_code == 200, finished.data
    capture.refresh_from_db()
    enable_library(capture)
    for chunk in capture.audio_chunks.all():
        with default_storage.open(chunk.object_key, "rb") as stream:
            state.data[chunk.object_key] = stream.read()
    monkeypatch.setattr(inputs, "audio_storage", lambda: state.storage)
    monkeypatch.setattr(objects, "audio_storage", lambda: state.storage)
    job = prepare(owner, capture)
    monkeypatch.setattr(worker.provider, "submit", Mock(return_value="synthetic-task"))
    output = result()
    output["properties"]["original_duration_in_milliseconds"] = 30000
    output["transcripts"][0]["sentences"] = [
        {"begin_time": 0, "end_time": 10000, "speaker_id": 0},
        {"begin_time": 10000, "end_time": 30000, "speaker_id": 1},
    ]
    monkeypatch.setattr(worker.provider, "poll", Mock(return_value=output))
    worker.process(job.pk)
    ready(job)
    worker.process(job.pk)
    job.refresh_from_db()
    assert job.status == "succeeded", job.error_code
    capture.record.refresh_from_db()
    return owner, capture, job


def test_two_recorded_speakers_queue_suggestions_and_require_sequential_human_confirmation(
    private_s3, monkeypatch
):
    owner, capture, source_job = long_published(private_s3, monkeypatch)
    profile = register(owner, capture.record.organization)
    batch_data = speaker_identification.submit(
        capture.record_id,
        owner,
        organization_id=capture.record.organization_id,
        user_ids=[owner.pk],
        expected_revision=capture.record.revision,
        request_key=uuid4(),
    )
    batch = models.SpeakerIdentityRequest.objects.get(pk=batch_data["request"]["id"])
    assert batch.jobs.count() == 2
    for job in batch.jobs.order_by("pk"):
        lease = speaker_identity_jobs.claim(job.pk)
        assert lease and speaker_identity_jobs.authorized(lease)
        offset = 0 if job.speaker.source_key == "0" else 10000
        query = ProducedQuery(
            "ready",
            "quality_passed",
            lease.source.fingerprint,
            tuple(
                replace(
                    clip,
                    start_ms=offset + index * 3200 + 100,
                    end_ms=offset + index * 3200 + 3100,
                )
                for index, clip in enumerate(clips())
            ),
            lease.source.media_sha256,
            job.speaker_id,
        )
        assert speaker_identity_jobs.finish(lease, query=query)
    assert all(speaker.user_id is None for speaker in capture.record.speakers.all())
    suggestions = [job.suggestion for job in batch.jobs.order_by("pk")]
    case = SimpleNamespace(actor=owner, record=capture.record)
    assert decide(case, suggestions[0]).status_code == 200
    assert decide(case, suggestions[1]).status_code == 200
    assert set(capture.record.speakers.values_list("user_id", flat=True)) == {
        owner.pk,
        None,
    }
    assert profile.samples.count() == 3 and profile.templates.count() == 1
    assert capture.record.identity_decisions.count() == 2


def test_capture_identity_rejects_changed_media_and_uses_its_own_storage_configuration(
    private_s3, monkeypatch
):
    owner, capture, _ = long_published(private_s3, monkeypatch)
    register(owner, capture.record.organization)
    batch_data = speaker_identification.submit(
        capture.record_id,
        owner,
        organization_id=capture.record.organization_id,
        user_ids=[owner.pk],
        expected_revision=capture.record.revision,
        request_key=uuid4(),
    )
    jobs = list(
        models.SpeakerIdentityJob.objects.filter(
            batch_id=batch_data["request"]["id"]
        ).order_by("speaker__source_key")
    )
    lease = speaker_identity_jobs.claim(jobs[0].pk)
    assert lease
    bad_query = ProducedQuery(
        "ready",
        "quality_passed",
        lease.source.fingerprint,
        tuple(
            replace(clip, start_ms=i * 3200 + 100, end_ms=i * 3200 + 3100)
            for i, clip in enumerate(clips())
        ),
        "0" * 64,
        jobs[0].speaker_id,
    )
    assert not speaker_identity_jobs.finish(lease, query=bad_query)
    jobs[0].refresh_from_db()
    assert jobs[0].status == "failed" and jobs[0].error_code == "identity_query_invalid"
    assert not models.SpeakerIdentitySuggestion.objects.filter(job=jobs[0]).exists()

    def produce(source, speaker_id, **kwargs):
        assert kwargs["storage_config"] == from_storage(private_s3.storage)
        assert kwargs["authorized"]()
        return ProducedQuery(
            "insufficient_audio",
            "clean_intervals_required",
            source.fingerprint,
            speaker_id=speaker_id,
        )

    producing = Mock(side_effect=produce)
    monkeypatch.setattr(speaker_identity_jobs.producer, "produce", producing)
    assert (
        speaker_identity_jobs.process_one(
            jobs[1].pk,
            media_config=Mock(),
            storage_config=replace(
                from_storage(private_s3.storage), bucket="upload-only"
            ),
            encoder_config=Mock(),
            quality_config=Mock(),
        )
        == "succeeded"
    )
    producing.assert_called_once()
    assert not capture.record.identity_decisions.exists()


def test_asr_state_exposes_current_derivation_without_loading_its_large_proof(
    private_s3, monkeypatch, settings
):
    owner, capture, job, _ = published(private_s3, monkeypatch)
    endpoint = f"/api/v1.0/capture-sessions/{capture.pk}/transcription/"
    with CaptureQueriesContext(connection) as queries:
        response = client_for(owner).get(endpoint)
    assert response.status_code == 200
    assert response.data["diarization_available"]
    assert response.data["active_diarization_job_id"] == str(job.pk)
    capture_endpoint = f"/api/v1.0/capture-sessions/{capture.pk}/"
    assert client_for(owner).get(capture_endpoint).data[
        "active_diarization_job_id"
    ] == str(job.pk)
    assert all(
        '"core_capturediarizationjob"."inputs"' not in item["sql"] for item in queries
    )
    settings.MEETING_CAPTURE_DIARIZATION_ENABLED = False
    assert client_for(owner).get(endpoint).data["diarization_available"]
    models.CaptureSession.objects.filter(pk=capture.pk).update(
        active_transcription=None
    )
    assert client_for(owner).get(endpoint).data["active_diarization_job_id"] is None
    assert (
        client_for(owner).get(capture_endpoint).data["active_diarization_job_id"]
        is None
    )
