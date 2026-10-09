"""Real DB leases and synthetic transport results; no human identity evaluation."""

import base64
import io
import json
import struct
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import close_old_connections, transaction
from django.utils import timezone

import pytest

from core import models
from core.factories import UserFactory
from core.services import voiceprint_consent as consent
from core.services import voiceprint_jobs as service
from core.services import voiceprint_rpc_process as process
from core.services.voiceprint_crypto import load_keyring
from core.services.voiceprint_encoder import EncoderError, decode_result
from core.services.voiceprint_enrollment import sample_snapshot
from core.tests.services.test_voiceprint_enrollment import (
    actor,
    begin,
    enabled,
    upload,
    wav,
)
from core.tests.test_services_voiceprint_encoder import output
from core.tests.test_services_voiceprint_rpc_process import upstream

pytestmark = pytest.mark.django_db


def result_for(lease, **changes):
    body = {**output(), "input_sha256": lease.audio_digest, **changes}
    return decode_result(body, lease.audio_digest)


def job_for(actor):
    return upload(actor, begin(actor)).encoding_job


def test_lease_is_exclusive_and_result_is_encrypted_signal_only(actor):
    job = job_for(actor)
    lease = service.claim(job.pk)
    assert lease.wav == wav() and wav().hex() not in repr(lease)
    job.refresh_from_db()
    assert job.status == "running" and job.attempts == 1
    assert service.claim(job.pk) is None and service.authorized(lease)
    result = result_for(lease)
    assert service.finish(lease, result=result)
    job.refresh_from_db()
    assert job.status == "succeeded" and job.lease_token is job.lease_until is None
    sample = models.VoiceprintSample.objects.get(pk=job.sample_id)
    clear = load_keyring().decrypt(
        sample.profile,
        sample.encrypted_embedding,
        kind="embedding",
        object_id=sample.pk,
    )
    assert clear == struct.pack("<1024f", *result.vector)
    assert sample.encrypted_embedding != clear
    assert sample_snapshot(sample)["status"] == "quality_pending"
    assert not sample_snapshot(sample)["confirmable"]
    assert sample.profile.templates.count() == 0
    assert not service.finish(lease, result=result)


def test_reclaimed_lease_rejects_old_result_and_preserves_current_run(actor):
    job = job_for(actor)
    old = service.claim(job.pk)
    models.VoiceprintEncodingJob.objects.filter(pk=job.pk).update(
        lease_until=timezone.now()
    )
    current = service.claim(job.pk)
    assert old.token != current.token
    assert not service.authorized(old) and service.authorized(current)
    assert not service.finish(old, result=result_for(old))
    job.refresh_from_db()
    assert job.lease_token == current.token and job.status == "running"
    assert service.finish(current, result=result_for(current))


def test_permission_change_during_rpc_never_persists_result(actor):
    job = job_for(actor)
    lease = service.claim(job.pk)
    consent.update_settings(
        actor,
        organization_id=None,
        expected_version=1,
        changes={"allow_enrollment": False},
    )
    assert not service.authorized(lease)
    assert not service.finish(lease, result=result_for(lease))
    job.refresh_from_db()
    assert job.status == "canceled"
    assert not models.VoiceprintSample.objects.get(pk=job.sample_id).encrypted_embedding


def test_old_generation_result_cannot_replace_new_enrollment(actor):
    old_job = job_for(actor)
    lease = service.claim(old_job.pk)
    consent.delete_profile(
        actor,
        profile_id=old_job.sample.profile_id,
        expected_version=1,
        request_key=uuid4(),
    )
    consent.update_settings(
        actor,
        organization_id=None,
        expected_version=2,
        changes={"allow_enrollment": True},
    )
    new = upload(actor, begin(actor, expected_version=3))
    before = bytes(new.encrypted_audio)
    assert not service.finish(lease, result=result_for(lease))
    new.refresh_from_db()
    assert bytes(new.encrypted_audio) == before and new.generation > lease.generation
    assert new.status == "pending" and not new.encrypted_embedding


@pytest.mark.parametrize(
    "change", ["digest", "cipher", "duration", "interval", "permit"]
)
def test_changed_source_is_discarded_before_result_write(actor, change):
    job = job_for(actor)
    lease = service.claim(job.pk)
    values = {
        "digest": {"audio_sha256": "0" * 64},
        "cipher": {"encrypted_audio": b"changed"},
        "duration": {"end_ms": 4000},
        "interval": {"start_ms": 1000, "end_ms": 4000},
        "permit": {"permit_id": uuid4()},
    }[change]
    models.VoiceprintSample.objects.filter(pk=job.sample_id).update(**values)
    assert not service.finish(lease, result=result_for(lease))
    assert not models.VoiceprintSample.objects.get(pk=job.sample_id).encrypted_embedding


def test_retry_budget_is_three_and_terminal_failure_clears_payload(actor):
    job = job_for(actor)
    for attempt in range(1, 4):
        lease = service.claim(job.pk)
        assert lease is not None
        service.finish(
            lease, error=EncoderError("encoder_transport_unavailable", retryable=True)
        )
        job.refresh_from_db()
        assert job.attempts == attempt and job.retryable == (attempt < 3)
    assert service.claim(job.pk) is None
    sample = models.VoiceprintSample.objects.get(pk=job.sample_id)
    assert sample.status == "rejected" and not sample.encrypted_audio


def test_expired_third_lease_cannot_stick_running_or_pending(actor):
    job = job_for(actor)
    models.VoiceprintEncodingJob.objects.filter(pk=job.pk).update(attempts=2)
    lease = service.claim(job.pk)
    models.VoiceprintEncodingJob.objects.filter(pk=job.pk).update(
        lease_until=timezone.now()
    )
    assert not service.finish(lease, result=result_for(lease))
    job.refresh_from_db()
    assert job.status == "failed" and not job.retryable and job.attempts == 3
    assert models.VoiceprintSample.objects.get(pk=job.sample_id).status == "rejected"


def test_worker_recovers_abandoned_final_attempt_without_rpc(actor):
    job = job_for(actor)
    models.VoiceprintEncodingJob.objects.filter(pk=job.pk).update(
        status="running", attempts=3, lease_until=timezone.now()
    )
    assert job.pk in service.pending_ids(10)
    assert service.claim(job.pk) is None
    job.refresh_from_db()
    assert job.status == "failed" and job.error_code == "attempts_exhausted"
    assert models.VoiceprintSample.objects.get(pk=job.sample_id).encrypted_audio == b""


def test_expired_clip_is_cleaned_before_rpc(actor):
    job = job_for(actor)
    models.VoiceprintSample.objects.filter(pk=job.sample_id).update(
        expires_at=timezone.now()
    )
    assert service.claim(job.pk) is None
    job.refresh_from_db()
    assert job.status == "expired"
    assert models.VoiceprintSample.objects.get(pk=job.sample_id).encrypted_audio == b""


def test_payload_integrity_is_checked_before_rpc(actor):
    job = job_for(actor)
    models.VoiceprintSample.objects.filter(pk=job.sample_id).update(
        audio_sha256="0" * 64
    )
    assert service.claim(job.pk) is None
    job.refresh_from_db()
    assert job.error_code == "audio_digest_mismatch"


@pytest.mark.parametrize(
    "damage", ["duration_ms", "speech_checked", "speaker_consistency_checked"]
)
def test_worker_rejects_mismatched_duration_and_forged_quality(actor, damage):
    job = job_for(actor)
    lease = service.claim(job.pk)
    result = result_for(lease)
    result.quality[damage] = 4000 if damage == "duration_ms" else True
    assert not service.finish(lease, result=result)
    job.refresh_from_db()
    assert job.error_code == "encoder_response_invalid"


def test_actual_subprocess_http_flow_keeps_signal_only_sample_quarantined(
    actor, upstream
):
    job = job_for(actor)
    assert service.process_one(job.pk, upstream.config) == "succeeded"
    sample = models.VoiceprintSample.objects.get(pk=job.sample_id)
    assert sample_snapshot(sample)["status"] == "quality_pending"
    assert (
        len(
            load_keyring().decrypt(
                sample.profile,
                sample.encrypted_embedding,
                kind="embedding",
                object_id=sample.pk,
            )
        )
        == 4096
    )
    assert upstream.requests == 1 and not sample.profile.templates.exists()


def test_reparented_sample_cannot_enroll_another_owner(actor):
    job = job_for(actor)
    lease = service.claim(job.pk)
    other = UserFactory()
    consent.update_settings(
        other,
        organization_id=None,
        expected_version=0,
        changes={"allow_enrollment": True},
    )
    new_profile = begin(other).profile
    models.VoiceprintSample.objects.filter(pk=job.sample_id).update(profile=new_profile)
    assert not service.authorized(lease)
    assert not service.finish(lease, result=result_for(lease))
    assert not models.VoiceprintSample.objects.get(pk=job.sample_id).encrypted_embedding


def test_invalid_configuration_and_disabled_worker_do_not_claim(actor, settings):
    job = job_for(actor)
    settings.MEETING_VOICEPRINT_ENABLED = False
    output_stream = io.StringIO()
    call_command("process_voiceprints", stdout=output_stream)
    assert json.loads(output_stream.getvalue())["enabled"] is False
    settings.MEETING_VOICEPRINT_ENABLED = True
    settings.MEETING_VOICEPRINT_ENCODER_CONFIG_FILE = "missing-config"
    with pytest.raises(CommandError, match="encoder_configuration_invalid"):
        call_command("process_voiceprints")
    with pytest.raises(CommandError, match="Limit"):
        call_command("process_voiceprints", limit=101)
    job.refresh_from_db()
    assert job.attempts == 0 and job.status == "queued"


def test_bounded_command_uses_independent_transport_once(
    actor, settings, tmp_path, monkeypatch
):
    enrollment = begin(actor)
    first = upload(actor, enrollment)
    second = upload(actor, enrollment, slot=1, audio=wav(121))
    path = tmp_path / "encoder.json"
    path.write_text(
        json.dumps(
            {
                "url": "http://127.0.0.1:12345",
                "api_token": "a" * 32,
                "permit_key": base64.b64encode(b"b" * 32).decode(),
                "ca_bundle": True,
            }
        )
    )
    settings.MEETING_VOICEPRINT_ENCODER_CONFIG_FILE = str(path)
    calls = []

    def fake_extract(body, *, config, job_id, lease_expires_at, authorized):
        assert (
            body == wav()
            and authorized()
            and lease_expires_at > timezone.now().timestamp()
        )
        calls.append(job_id)
        return decode_result(
            {**output(), "input_sha256": first.audio_sha256}, first.audio_sha256
        )

    monkeypatch.setattr(process, "extract", fake_extract)
    stream = io.StringIO()
    call_command("process_voiceprints", limit=1, stdout=stream)
    assert json.loads(stream.getvalue())["succeeded"] == 1
    assert calls == [first.encoding_job.pk]
    second.encoding_job.refresh_from_db()
    assert second.encoding_job.status == "queued" and second.encoding_job.attempts == 0


@pytest.mark.django_db(transaction=True)
def test_parallel_workers_cannot_both_claim_one_sample():
    user = UserFactory()
    consent.update_settings(
        user,
        organization_id=None,
        expected_version=0,
        changes={"allow_enrollment": True},
    )
    job = job_for(user)

    def request(_):
        close_old_connections()
        try:
            return service.claim(job.pk)
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as executor:
        leases = list(executor.map(request, range(2)))
    assert sum(lease is not None for lease in leases) == 1
    job.refresh_from_db()
    assert job.attempts == 1


@pytest.mark.django_db(transaction=True)
def test_busy_scope_is_skipped_without_waiting():
    user = UserFactory()
    consent.update_settings(
        user,
        organization_id=None,
        expected_version=0,
        changes={"allow_enrollment": True},
    )
    job = job_for(user)
    with transaction.atomic():
        models.User.objects.select_for_update().get(pk=user.pk)

        def other_connection():
            close_old_connections()
            try:
                return service.claim(job.pk)
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=1) as executor:
            assert executor.submit(other_connection).result(timeout=3) is None
