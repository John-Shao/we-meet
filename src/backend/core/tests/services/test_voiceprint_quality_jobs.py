"""Real DB/HTTP quality transitions using only synthetic provider evidence."""

import io
import json
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import close_old_connections
from django.utils import timezone

import pytest

from core import models
from core.services import voiceprint_consent as consent
from core.services import voiceprint_enrollment as enrollment
from core.services import voiceprint_jobs as encoding
from core.services import voiceprint_quality as quality
from core.services import voiceprint_quality_jobs as service
from core.services import voiceprint_templates as templates
from core.services.voiceprint_crypto import load_keyring
from core.services.voiceprint_encoder import decode_result
from core.services.voiceprint_prompt import challenge_digest
from core.services.voiceprint_vectors import read_sample_vector
from core.tests.services.test_meeting_records import client_for
from core.tests.services.test_voiceprint_enrollment import (
    actor,
    begin,
    enabled,
    upload,
    wav,
)
from core.tests.test_services_voiceprint_encoder import output as encoder_output
from core.tests.test_services_voiceprint_quality import output as asr_output
from core.tests.test_services_voiceprint_quality_process import short_asr

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def quality_enabled(settings, enabled):
    settings.MEETING_VOICEPRINT_QUALITY_ENABLED = True
    settings.MEETING_VOICEPRINT_TEMPLATES_ENABLED = True


def candidate(actor, registration=None, *, seconds=3, slot=0):
    sample = upload(
        actor,
        registration or begin(actor),
        slot=slot,
        audio=wav(value=120 + slot, seconds=seconds),
    )
    lease = encoding.claim(sample.encoding_job.pk)
    result = encoder_output()
    result["quality"]["duration_ms"] = seconds * 1000
    result["input_sha256"] = lease.audio_digest
    assert encoding.finish(lease, result=decode_result(result, lease.audio_digest))
    sample.refresh_from_db()
    return sample


def result_for(lease, *, body=None):
    return {
        **quality.interpret(
            body or asr_output(lease.prompt, duration=lease.duration_ms),
            duration=lease.duration_ms,
            locale=lease.locale,
            prompt=lease.prompt,
        ),
        "input_sha256": lease.audio_digest,
    }


def test_signal_only_encoding_creates_a_separate_unconfirmable_quality_receipt(actor):
    sample = candidate(actor)
    assert (
        sample.encoding_job.status == "succeeded"
        and sample.quality_job.status == "queued"
    )
    assert enrollment.sample_snapshot(sample)["status"] == "quality_pending"
    lease = service.claim(sample.quality_job.pk)
    assert lease and service.claim(lease.job_id) is None
    assert wav().hex() not in repr(lease) and lease.prompt not in repr(lease)
    assert service.finish(lease, result=result_for(lease))
    sample.refresh_from_db()
    assert (
        enrollment.sample_quality_ready(sample)
        and enrollment.sample_snapshot(sample)["confirmable"]
    )
    assert sample.status == "ready" and not sample.profile.templates.exists()
    clear = load_keyring().decrypt(
        sample.profile,
        sample.encrypted_embedding,
        kind="embedding",
        object_id=sample.pk,
    )
    assert len(read_sample_vector(sample, clear)) == 1024
    assert lease.prompt.encode() not in clear and "text" not in sample.quality
    assert not service.finish(lease, result=result_for(lease))
    assert service.claim(lease.job_id) is None


def test_forged_checked_metadata_cannot_cancel_verification_as_already_done(actor):
    sample = candidate(actor)
    sample.quality.update(
        {
            "speech_checked": True,
            "speaker_consistency_checked": True,
            "valid_speech_ms": 3000,
            "speech_validation": quality.POLICY_VERSION,
            "asr_model_id": quality.MODEL_ID,
            "speaker_count": 1,
            "prompt_checked": True,
            "prompt_sha256": challenge_digest(
                sample.enrollment.locale, sample.enrollment.challenges[0]
            ),
        }
    )
    sample.save()
    assert service.claim(sample.quality_job.pk) is None
    sample.refresh_from_db()
    assert sample.quality_job.error_code == "quality_input_invalid"
    assert sample.status == "rejected" and not sample.encrypted_embedding


def test_authenticated_previously_checked_sample_is_preserved_without_another_rpc(
    actor,
):
    sample = candidate(actor)
    lease = service.claim(sample.quality_job.pk)
    service.finish(lease, result=result_for(lease))
    models.VoiceprintQualityJob.objects.filter(pk=lease.job_id).update(status="queued")
    assert service.claim(lease.job_id) is None
    sample.refresh_from_db()
    assert sample.quality_job.error_code == "quality_already_checked"
    assert enrollment.sample_quality_ready(sample) and sample.encrypted_audio


def test_full_api_encoding_quality_confirmation_template_flow_uses_independent_grants(
    actor, short_asr
):
    registration = begin(actor)
    for slot in range(3):
        sample = candidate(actor, registration, slot=slot, seconds=10)
        short_asr.prompt, short_asr.duration = registration.challenges[slot], 10000
        assert (
            service.process_one(sample.quality_job.pk, short_asr.config) == "succeeded"
        )
        response = client_for(actor).post(
            f"/api/v1.0/voiceprint/samples/{sample.pk}/decision/",
            {"expected_version": 1, "accepted": True},
            format="json",
        )
        assert response.status_code == 200 and response.data["status"] == "confirmed"
    profile = sample.profile
    assert templates.build(profile.pk).status == "built" and consent.profile_ready(
        profile
    )
    profile.consent.refresh_from_db()
    assert (
        not profile.consent.allow_identification
        and not profile.consent.allow_accumulation
    )
    consent.update_settings(
        actor,
        organization_id=None,
        expected_version=1,
        changes={"allow_identification": True},
    )
    assert consent.authorize_profile(profile.pk, permission="allow_identification")
    assert short_asr.requests == 3


@pytest.mark.parametrize(
    "reason", ["mixed_speaker", "insufficient_audio", "prompt_mismatch"]
)
def test_definite_quality_rejection_clears_candidate_payloads(actor, reason):
    sample = candidate(actor)
    lease = service.claim(sample.quality_job.pk)
    if reason == "mixed_speaker":
        body = asr_output(lease.prompt)
        body["output"]["sentences"][0]["words"][-1]["speaker_id"] = 1
    elif reason == "insufficient_audio":
        body = {"output": {"sentences": []}}
    else:
        body = asr_output("unrelated numbers 10 10 10 10 10 10")
    result = result_for(lease, body=body)
    assert result["reason"] == reason and service.finish(lease, result=result)
    sample.refresh_from_db()
    assert (
        sample.status == "rejected"
        and sample.encrypted_audio == sample.encrypted_embedding == b""
    )
    assert (
        sample.quality_job.status == "succeeded"
        and sample.quality["quality_rejection"] == reason
    )
    assert not enrollment.sample_snapshot(sample)["confirmable"]


def test_cloud_unavailability_is_bounded_and_never_certifies_or_discards_audio(actor):
    sample = candidate(actor)
    original = bytes(sample.encrypted_embedding)
    for attempt in range(1, 4):
        lease = service.claim(sample.quality_job.pk)
        assert lease
        assert not service.finish(
            lease,
            error=quality.QualityError("quality_transport_unavailable", retryable=True),
        )
        sample.refresh_from_db()
        assert sample.quality_job.attempts == attempt
        assert sample.quality_job.retryable is (attempt < 3)
        assert sample.encrypted_audio and bytes(sample.encrypted_embedding) == original
        assert enrollment.sample_snapshot(sample)["status"] == "quality_pending"
    assert not service.pending_ids(10) and service.claim(sample.quality_job.pk) is None


def test_reclaimed_lease_never_accepts_the_old_quality_result(actor):
    sample = candidate(actor)
    old = service.claim(sample.quality_job.pk)
    models.VoiceprintQualityJob.objects.filter(pk=old.job_id).update(
        lease_until=timezone.now()
    )
    current = service.claim(old.job_id)
    assert old.token != current.token and not service.authorized(old)
    assert not service.finish(old, result=result_for(old))
    assert service.authorized(current) and service.finish(
        current, result=result_for(current)
    )


def test_abandoned_last_lease_returns_to_quality_pending_without_a_fourth_call(actor):
    sample = candidate(actor)
    for _ in range(3):
        lease = service.claim(sample.quality_job.pk)
        models.VoiceprintQualityJob.objects.filter(pk=lease.job_id).update(
            lease_until=timezone.now()
        )
    assert service.claim(lease.job_id) is None
    sample.refresh_from_db()
    assert sample.quality_job.attempts == 3 and sample.quality_job.status == "failed"
    assert (
        enrollment.sample_snapshot(sample)["status"] == "quality_pending"
        and sample.encrypted_audio
    )


@pytest.mark.parametrize(
    "damage",
    [
        "audio",
        "embedding",
        "digest",
        "source",
        "prompt",
        "locale",
        "interval",
        "quality",
    ],
)
def test_changed_source_or_challenge_cannot_receive_late_quality_evidence(
    actor, damage
):
    sample = candidate(actor)
    lease = service.claim(sample.quality_job.pk)
    result = result_for(lease)
    if damage in {"prompt", "locale"}:
        registration = sample.enrollment
        if damage == "prompt":
            registration.challenges[0] += " changed"
        else:
            registration.locale = "nl"
        registration.save()
    else:
        if damage == "audio":
            sample.encrypted_audio = b"changed"
        elif damage == "embedding":
            sample.encrypted_embedding = b"changed"
        elif damage == "digest":
            sample.audio_sha256 = uuid4().hex * 2
        elif damage == "source":
            sample.source_track = "different-track"
        elif damage == "interval":
            sample.end_ms += 1
        else:
            sample.quality["unchecked_flag"] = True
        sample.save()
    assert not service.finish(lease, result=result)
    sample.refresh_from_db()
    assert not enrollment.sample_quality_ready(
        sample
    ) and sample.quality_job.status in {"canceled", "failed"}


@pytest.mark.parametrize(
    "operation", ["consent", "reject", "delete", "expire", "disable"]
)
def test_revocation_and_lifecycle_stop_quality_jobs_before_commit(
    actor, operation, settings
):
    sample = candidate(actor)
    lease = service.claim(sample.quality_job.pk)
    if operation == "consent":
        consent.update_settings(
            actor,
            organization_id=None,
            expected_version=1,
            changes={"allow_enrollment": False},
        )
    elif operation == "reject":
        enrollment.decide(actor, sample.pk, expected_version=1, accepted=False)
    elif operation == "delete":
        consent.delete_profile(
            actor, profile_id=sample.profile_id, expected_version=1, request_key=uuid4()
        )
    elif operation == "expire":
        models.VoiceprintSample.objects.filter(pk=sample.pk).update(
            expires_at=timezone.now()
        )
    else:
        settings.MEETING_VOICEPRINT_QUALITY_ENABLED = False
    assert not service.authorized(lease) and not service.finish(
        lease, result=result_for(lease)
    )
    sample.refresh_from_db()
    assert not enrollment.sample_snapshot(sample)["confirmable"]


@pytest.mark.parametrize(
    "field,value",
    [
        ("input_sha256", "0" * 64),
        ("prompt_sha256", "0" * 64),
        ("passed", "true"),
        ("valid_speech_ms", 10001),
    ],
)
def test_invalid_evidence_is_unavailable_and_preserves_signal_only_proof(
    actor, field, value
):
    sample = candidate(actor)
    original = bytes(sample.encrypted_embedding)
    lease = service.claim(sample.quality_job.pk)
    result = result_for(lease)
    result[field] = value
    assert not service.finish(lease, result=result)
    sample.refresh_from_db()
    assert sample.quality_job.error_code == "quality_response_invalid"
    assert (
        bytes(sample.encrypted_embedding) == original
        and enrollment.sample_snapshot(sample)["status"] == "quality_pending"
    )


def test_current_prompt_change_invalidates_already_checked_and_confirmed_contribution(
    actor,
):
    sample = candidate(actor)
    lease = service.claim(sample.quality_job.pk)
    service.finish(lease, result=result_for(lease))
    sample.refresh_from_db()
    assert enrollment.sample_quality_ready(sample)
    registration = sample.enrollment
    registration.challenges[0] += " changed"
    registration.save()
    sample.refresh_from_db()
    assert not enrollment.sample_quality_ready(sample)
    with pytest.raises(consent.VoiceprintError, match="voiceprint_quality_pending"):
        enrollment.decide(actor, sample.pk, expected_version=1, accepted=True)


def test_command_defaults_and_invalid_configuration_do_not_claim_or_upload(
    actor, settings, short_asr
):
    sample = candidate(actor)
    settings.MEETING_VOICEPRINT_QUALITY_ENABLED = False
    stdout = io.StringIO()
    call_command("check_voiceprint_quality", limit=1, stdout=stdout)
    assert json.loads(stdout.getvalue())["enabled"] is False
    assert sample.quality_job.attempts == short_asr.requests == 0
    settings.MEETING_VOICEPRINT_QUALITY_ENABLED = True
    with pytest.raises(CommandError, match="quality_configuration_invalid"):
        call_command("check_voiceprint_quality", limit=1)
    sample.refresh_from_db()
    assert sample.quality_job.attempts == short_asr.requests == 0


def test_backfill_and_command_use_bounded_independent_quality_queue(
    actor, short_asr, settings, tmp_path
):
    sample = candidate(actor)
    sample.quality_job.delete()
    short_asr.prompt = sample.enrollment.challenges[0]
    path = tmp_path / "quality-config.json"
    path.write_text(json.dumps(short_asr.config.payload()))
    settings.MEETING_VOICEPRINT_QUALITY_CONFIG_FILE = str(path)
    stdout = io.StringIO()
    call_command("check_voiceprint_quality", limit=1, stdout=stdout)
    assert json.loads(stdout.getvalue())["admitted"] == 1 and short_asr.requests == 1
    assert (
        str(sample.pk) not in stdout.getvalue()
        and short_asr.prompt not in stdout.getvalue()
    )
    sample.refresh_from_db()
    assert enrollment.sample_quality_ready(sample)
    assert service.enqueue_ready(1) == 0


@pytest.mark.django_db(transaction=True)
def test_two_quality_workers_cannot_claim_the_same_sample(actor):
    sample = candidate(actor)

    def run():
        close_old_connections()
        try:
            return service.claim(sample.quality_job.pk)
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as workers:
        leases = list(workers.map(lambda _: run(), range(2)))
    assert sum(lease is not None for lease in leases) == 1
    sample.refresh_from_db()
    assert sample.quality_job.attempts == 1
