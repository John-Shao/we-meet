"""Call admission, independent quality and replay using only synthetic audio."""

from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlencode
from uuid import UUID

from django.db import close_old_connections
from django.utils import timezone

import pytest
from rest_framework.test import APIClient

from core import models
from core.services import voiceprint_consent as consent
from core.services import voiceprint_enrollment as enrollment
from core.services import voiceprint_jobs as encoding
from core.services import voiceprint_quality as quality
from core.services import voiceprint_quality_jobs as checking
from core.services import voiceprint_sampling as service
from core.services.voiceprint_crypto import load_keyring
from core.services.voiceprint_encoder import decode_result
from core.tests.services.test_voiceprint_enrollment import wav
from core.tests.services.test_voiceprint_sampling import PERMITS, Fixture, enabled
from core.tests.test_services_voiceprint_encoder import output as encoder_output
from core.tests.test_services_voiceprint_quality_process import short_asr

pytestmark = pytest.mark.django_db


def ingest(fixture, grant, audio=None):
    return service.ingest(
        UUID(grant["id"]), token=grant["token"], **fixture.wire(), wav=audio or wav()
    )


def candidate():
    fixture = Fixture()
    fixture.control()
    grant = fixture.issue()
    receipt = ingest(fixture, grant)
    return fixture, grant, models.VoiceprintSample.objects.get(pk=receipt["id"])


def signal_candidate():
    fixture, grant, sample = candidate()
    lease = encoding.claim(sample.encoding_job.pk)
    encoded = encoder_output()
    encoded["input_sha256"] = lease.audio_digest
    assert encoding.finish(lease, result=decode_result(encoded, lease.audio_digest))
    sample.refresh_from_db()
    return fixture, grant, sample


def test_call_quality_worker_uses_real_killable_subprocess_and_local_http(
    short_asr, settings
):
    settings.MEETING_VOICEPRINT_QUALITY_ENABLED = True
    fixture, grant, sample = signal_candidate()
    assert checking.process_one(sample.quality_job.pk, short_asr.config) == "succeeded"
    assert short_asr.requests == 1
    sample.refresh_from_db()
    assert enrollment.sample_snapshot(sample)["confirmable"]
    assert short_asr.prompt not in str(sample.quality)
    assert sample.quality["speech_validation"] == quality.CALL_POLICY_VERSION


def test_admission_encrypts_exact_source_and_replay_never_enqueues_twice():
    fixture, grant, sample = candidate()
    assert sample.source_type == "call" and sample.enrollment_id is None
    assert sample.source_session_id == fixture.session.pk
    assert sample.source_track == fixture.track.livekit_track_sid
    assert sample.status == "pending" and not sample.encrypted_embedding
    assert (
        load_keyring().decrypt(
            sample.profile, sample.encrypted_audio, kind="audio", object_id=sample.pk
        )
        == wav()
    )
    assert wav() not in bytes(sample.encrypted_audio)
    assert not enrollment.sample_snapshot(sample)["confirmable"]
    assert ingest(fixture, grant)["id"] == str(sample.pk)
    assert (
        models.VoiceprintSample.objects.count()
        == models.VoiceprintEncodingJob.objects.count()
        == 1
    )
    with pytest.raises(consent.VoiceprintError, match="request_conflict"):
        ingest(fixture, grant, wav(value=140))
    fixture.control(paused=True)
    assert ingest(fixture, grant)["id"] == str(sample.pk)
    consent.update_settings(
        fixture.user,
        organization_id=None,
        expected_version=1,
        changes={"allow_accumulation": False},
    )
    with pytest.raises(consent.VoiceprintError):
        ingest(fixture, grant)


@pytest.mark.parametrize(
    "change",
    [
        "pause",
        "shared",
        "expiry",
        "token",
        "participant",
        "room",
        "track",
        "consent",
        "flag",
    ],
)
def test_late_or_misbound_upload_never_leaves_audio_or_job(change, settings):
    fixture = Fixture()
    fixture.control()
    grant = fixture.issue()
    if change == "pause":
        fixture.control(paused=True)
    elif change == "shared":
        fixture.control(shared_microphone=True)
    elif change == "expiry":
        models.VoiceprintSamplingPermit.objects.filter(pk=grant["id"]).update(
            expires_at=timezone.now()
        )
    elif change == "token":
        grant["token"] = "声" * 43
    elif change in {"participant", "room", "track"}:
        original = fixture.wire()
        original[
            {
                "participant": "participant_sid",
                "room": "room_sid",
                "track": "track_sid",
            }[change]
        ] = "wrong"
        fixture.wire = lambda: original
    elif change == "consent":
        consent.update_settings(
            fixture.user,
            organization_id=None,
            expected_version=1,
            changes={"allow_accumulation": False},
        )
    else:
        settings.MEETING_VOICEPRINT_SAMPLING_ENABLED = False
    with pytest.raises(consent.VoiceprintError):
        ingest(fixture, grant)
    assert not models.VoiceprintSample.objects.exists()
    assert not models.VoiceprintEncodingJob.objects.exists()


def test_budget_duplicate_audio_and_invalid_wav_do_not_consume_a_new_permit(settings):
    settings.MEETING_VOICEPRINT_SAMPLING_CLIP_MS = 3000
    fixture, grant, sample = candidate()
    new = fixture.issue()
    for audio, code in [
        (wav(seconds=4), "clip_too_long"),
        (b"invalid", "wav_invalid"),
        (wav(), "duplicate_audio"),
    ]:
        with pytest.raises(consent.VoiceprintError, match=code):
            ingest(fixture, new, audio)
    assert models.VoiceprintSample.objects.count() == 1
    assert models.VoiceprintSamplingPermit.objects.get(pk=new["id"]).status == "issued"


def test_binary_endpoint_requires_distinct_credentials_and_bounded_headers(settings):
    fixture = Fixture()
    fixture.control()
    grant = fixture.issue()
    endpoint = PERMITS + grant["id"] + "/clip/?" + urlencode(fixture.wire())
    client = APIClient()
    assert client.put(endpoint, wav(), content_type="audio/wav").status_code == 403
    client.credentials(
        HTTP_X_VOICEPRINT_AGENT_TOKEN=settings.MEETING_VOICEPRINT_SAMPLING_AGENT_TOKEN
    )
    assert (
        client.put(endpoint, wav(), content_type="application/octet-stream").status_code
        == 415
    )
    assert (
        client.put(
            endpoint, wav(), content_type="audio/wav", CONTENT_LENGTH="999999"
        ).status_code
        == 413
    )
    assert (
        client.put(
            endpoint,
            wav(),
            content_type="audio/wav",
            HTTP_X_VOICEPRINT_PERMIT_TOKEN="wrong",
        ).status_code
        == 403
    )
    first = client.put(
        endpoint,
        wav(),
        content_type="audio/wav",
        HTTP_X_VOICEPRINT_PERMIT_TOKEN=grant["token"],
    )
    assert first.status_code == 202 and first["Cache-Control"] == "private, no-store"
    assert set(first.data) == {"id", "status", "expires_at"}
    assert (
        client.put(
            endpoint,
            wav(),
            content_type="audio/wav",
            HTTP_X_VOICEPRINT_PERMIT_TOKEN=grant["token"],
        ).data
        == first.data
    )


@pytest.mark.parametrize("reason", ["passed", "mixed_speaker", "insufficient_audio"])
def test_call_quality_uses_single_speaker_evidence_without_prompt(reason, settings):
    settings.MEETING_VOICEPRINT_QUALITY_ENABLED = True
    fixture, grant, sample = candidate()
    lease = encoding.claim(sample.encoding_job.pk)
    encoded = encoder_output()
    encoded["input_sha256"] = lease.audio_digest
    assert encoding.finish(lease, result=decode_result(encoded, lease.audio_digest))
    sample.refresh_from_db()
    lease = checking.claim(sample.quality_job.pk)
    assert lease and lease.prompt == lease.locale == ""
    result = {
        "policy": quality.QUERY_POLICY_VERSION,
        "model_id": quality.MODEL_ID,
        "input_sha256": lease.audio_digest,
        "passed": reason == "passed",
        "reason": reason,
        "valid_speech_ms": 3000 if reason != "insufficient_audio" else 0,
        "speaker_count": 2
        if reason == "mixed_speaker"
        else (1 if reason == "passed" else 0),
    }
    assert checking.finish(lease, result=result)
    sample.refresh_from_db()
    if reason == "passed":
        assert sample.quality["speech_validation"] == quality.CALL_POLICY_VERSION
        assert "prompt_checked" not in sample.quality
        assert enrollment.sample_snapshot(sample)["confirmable"]
        assert (
            not sample.profile.templates.exists() and sample.profile.status != "active"
        )
        enrollment.decide(fixture.user, sample.pk, expected_version=1, accepted=True)
        sample.refresh_from_db()
        assert sample.status == "confirmed"
    else:
        assert (
            sample.status == "rejected"
            and not sample.encrypted_audio
            and not sample.encrypted_embedding
        )
        control = service.read_control(
            fixture.user,
            session_id=fixture.session.pk,
            participant_sid=fixture.participant.livekit_participant_sid,
        )
        assert control["paused"] is (reason == "mixed_speaker")
        assert control["stop_reason"] == (
            "mixed_speaker" if reason == "mixed_speaker" else ""
        )


@pytest.mark.django_db(transaction=True)
def test_concurrent_same_permit_uploads_create_one_candidate_and_one_job():
    fixture = Fixture()
    fixture.control()
    grant = fixture.issue()

    def upload(_):
        close_old_connections()
        try:
            return ingest(fixture, grant)["id"]
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(upload, range(2)))
    assert results[0] == results[1]
    assert (
        models.VoiceprintSample.objects.count()
        == models.VoiceprintEncodingJob.objects.count()
        == 1
    )


def test_late_mixed_speaker_result_does_not_pause_an_explicit_new_declaration(settings):
    settings.MEETING_VOICEPRINT_QUALITY_ENABLED = True
    fixture, grant, sample = signal_candidate()
    lease = checking.claim(sample.quality_job.pk)
    fixture.control(device_group="computer")
    fresh = fixture.issue()
    result = {
        "policy": quality.QUERY_POLICY_VERSION,
        "model_id": quality.MODEL_ID,
        "input_sha256": lease.audio_digest,
        "passed": False,
        "reason": "mixed_speaker",
        "valid_speech_ms": 3000,
        "speaker_count": 2,
    }
    assert checking.finish(lease, result=result)
    control = service.read_control(
        fixture.user,
        session_id=fixture.session.pk,
        participant_sid=fixture.participant.livekit_participant_sid,
    )
    assert (
        control["revision"] == 2
        and not control["paused"]
        and not control["stop_reason"]
    )
    assert fixture.validate(fresh)["id"] == fresh["id"]
