"""Synthetic registration boundary regression; no human accuracy assertions."""

import base64
import hashlib
import io
import json
import os
import struct
import wave
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

from django.db import IntegrityError, close_old_connections, transaction
from django.db.models import QuerySet
from django.utils import timezone

import pytest

from core import models
from core.factories import MembershipFactory, OrganizationFactory, UserFactory
from core.services import voiceprint_consent as consent
from core.services import voiceprint_enrollment as service
from core.services.voiceprint_consent import VoiceprintError
from core.services.voiceprint_crypto import load_keyring
from core.services.voiceprint_retention import expire_sample

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def enabled(settings, tmp_path):
    settings.MEETING_VOICEPRINT_ENABLED = True
    path = tmp_path / "keyring.json"
    path.write_text(
        json.dumps(
            {
                "active": "test",
                "keys": {
                    "test": base64.b64encode(os.urandom(32)).decode("ascii"),
                },
            }
        )
    )
    settings.MEETING_VOICEPRINT_KEYRING_FILE = str(path)


@pytest.fixture
def actor():
    user = UserFactory()
    consent.update_settings(
        user,
        organization_id=None,
        expected_version=0,
        changes={"allow_enrollment": True},
    )
    return user


def wav(value=120, *, seconds=3, channels=1, rate=24000):
    output = io.BytesIO()
    with wave.open(output, "wb") as writer:
        writer.setnchannels(channels)
        writer.setsampwidth(2)
        writer.setframerate(rate)
        writer.writeframes(struct.pack("<h", value) * rate * seconds * channels)
    return output.getvalue()


def begin(actor, **extra):
    return service.begin(
        actor,
        **{
            "organization_id": None,
            "expected_version": 1,
            "request_key": uuid4(),
            "locale": "en",
            **extra,
        },
    )


def upload(actor, enrollment, *, slot=0, audio=None, token=None):
    return service.upload(
        actor,
        enrollment_id=enrollment.pk,
        slot=slot,
        token=token
        if token is not None
        else service.enrollment_snapshot(enrollment)["upload_token"],
        wav=audio if audio is not None else wav(),
    )


def ready(sample):
    sample.status = "ready"
    sample.quality = {
        "speech_checked": True,
        "speaker_consistency_checked": True,
        "valid_speech_ms": 3000,
    }
    sample.encrypted_embedding = load_keyring().encrypt(
        sample.profile, b"synthetic embedding", kind="embedding", object_id=sample.pk
    )
    sample.save()
    return sample


def test_non_ascii_upload_token_is_rejected_with_stable_error(actor):
    enrollment = begin(actor)
    with pytest.raises(VoiceprintError, match="voiceprint_upload_denied"):
        upload(actor, enrollment, token="\u4e2d" * 43)
    assert not models.VoiceprintSample.objects.exists()


def test_confirmed_replay_rechecks_current_authorization(actor):
    sample = ready(upload(actor, begin(actor)))
    service.decide(actor, sample.pk, expected_version=1, accepted=True)
    models.VoiceprintProfile.objects.filter(pk=sample.profile_id).update(
        status="deleted", encrypted_key=b""
    )
    with pytest.raises(VoiceprintError, match="voiceprint_authorization_revoked"):
        service.decide(actor, sample.pk, expected_version=1, accepted=True)


def test_closed_receipt_and_sample_snapshot_hide_revoked_access(actor):
    enrollment = begin(actor)
    sample = ready(upload(actor, enrollment))
    enrollment.status = "closed"
    enrollment.save()
    consent.update_settings(
        actor,
        organization_id=None,
        expected_version=1,
        changes={"allow_enrollment": False},
    )
    assert service.enrollment_snapshot(enrollment)["status"] == "canceled"
    result = service.sample_snapshot(sample)
    assert result["confirmable"] is False
    assert result["audio_available"] is False


def test_audio_checks_payload_digest(actor):
    sample = upload(actor, begin(actor))
    sample.encrypted_audio = load_keyring().encrypt(
        sample.profile, wav(121), kind="audio", object_id=sample.pk
    )
    sample.save()
    with pytest.raises(VoiceprintError, match="voiceprint_audio_unavailable"):
        service.sample_audio(actor, sample.pk)


def test_audio_rechecks_revocation_during_decryption(actor, monkeypatch):
    sample = upload(actor, begin(actor))
    ring = load_keyring()
    original = ring.decrypt

    def revoke_during_read(*args, **kwargs):
        clear = original(*args, **kwargs)
        consent.update_settings(
            actor,
            organization_id=None,
            expected_version=1,
            changes={"allow_enrollment": False},
        )
        return clear

    monkeypatch.setattr(ring, "decrypt", revoke_during_read)
    monkeypatch.setattr(service, "load_keyring", lambda: ring)
    with pytest.raises(VoiceprintError, match="voiceprint_authorization_revoked"):
        service.sample_audio(actor, sample.pk)


def test_audio_cannot_cross_expiry_during_decryption(actor, monkeypatch):
    sample = upload(actor, begin(actor))
    ring = load_keyring()
    original = ring.decrypt

    def expire_during_read(*args, **kwargs):
        clear = original(*args, **kwargs)
        monkeypatch.setattr(service.timezone, "now", lambda: sample.expires_at)
        return clear

    monkeypatch.setattr(ring, "decrypt", expire_during_read)
    monkeypatch.setattr(service, "load_keyring", lambda: ring)
    with pytest.raises(VoiceprintError, match="voiceprint_audio_unavailable"):
        service.sample_audio(actor, sample.pk)


def test_revoke_cancels_pending_job_and_upload_receipt(actor):
    enrollment = begin(actor)
    sample = upload(actor, enrollment)
    consent.delete_profile(
        actor, profile_id=sample.profile_id, expected_version=1, request_key=uuid4()
    )
    enrollment.refresh_from_db()
    sample.encoding_job.refresh_from_db()
    assert enrollment.status == "canceled"
    assert sample.encoding_job.status == "canceled"


def test_expiry_cancels_unconfirmed_job_lease(actor):
    sample = upload(actor, begin(actor))
    models.VoiceprintSample.objects.filter(pk=sample.pk).update(
        expires_at=timezone.now()
    )
    models.VoiceprintEncodingJob.objects.filter(sample=sample).update(
        status="running",
        lease_token=uuid4(),
        lease_until=timezone.now() + timezone.timedelta(minutes=1),
    )
    assert expire_sample(sample.pk)
    sample.encoding_job.refresh_from_db()
    assert sample.encoding_job.status == "expired"
    assert sample.encoding_job.lease_token is None


def test_identical_pcm_with_metadata_is_duplicate_not_new_evidence(actor):
    enrollment = begin(actor)
    body = wav()
    upload(actor, enrollment, audio=body)
    extra = b"JUNK" + struct.pack("<I", 4) + b"meta"
    modified = (
        body[:4] + struct.pack("<I", len(body) + len(extra) - 8) + body[8:] + extra
    )
    with pytest.raises(VoiceprintError, match="voiceprint_duplicate_audio"):
        upload(actor, enrollment, slot=1, audio=modified)


@pytest.mark.parametrize(
    "modify",
    [
        lambda body: body + b"trailing data",
        lambda body: body[:4] + struct.pack("<I", len(body) + 4) + body[8:],
        lambda body: body[:28] + struct.pack("<I", 1) + body[32:],
    ],
)
def test_malformed_riff_cannot_be_admitted(actor, modify):
    with pytest.raises(VoiceprintError, match="voiceprint_wav_invalid"):
        upload(actor, begin(actor), audio=modify(wav()))


@pytest.mark.parametrize("value", [True, 1.0, "1"])
def test_service_versions_are_strict_integers(actor, value):
    with pytest.raises(VoiceprintError, match="voiceprint_settings_invalid"):
        begin(actor, expected_version=value)


def test_registration_private_encrypted_and_idempotent(actor):
    identifier = uuid4()
    enrollment = begin(actor, request_key=identifier, locale="zh-CN")
    assert len(enrollment.challenges) == 6
    assert "当前账户" in enrollment.challenges[0]
    assert begin(actor, request_key=identifier, locale="zh-CN").pk == enrollment.pk
    body = wav()
    sample = upload(actor, enrollment, audio=body)
    assert sample.encrypted_audio != body
    assert sample.audio_sha256 == hashlib.sha256(body).hexdigest()
    assert sample.encoding_job.status == "queued"
    assert service.sample_audio(actor, sample.pk) == body
    assert upload(actor, enrollment, audio=body).pk == sample.pk
    assert "encrypted_audio" not in service.sample_snapshot(sample)
    with pytest.raises(VoiceprintError, match="voiceprint_request_conflict"):
        upload(actor, enrollment, audio=wav(122))


def test_receipts_enforce_quota_even_after_profile_deletion(actor):
    first = begin(actor)
    begin(actor)
    begin(actor)
    with pytest.raises(VoiceprintError, match="voiceprint_enrollment_quota"):
        begin(actor)
    consent.delete_profile(
        actor, profile_id=first.profile_id, expected_version=1, request_key=uuid4()
    )
    consent.update_settings(
        actor,
        organization_id=None,
        expected_version=2,
        changes={"allow_enrollment": True},
    )
    assert begin(actor, request_key=first.request_key).pk == first.pk
    with pytest.raises(VoiceprintError, match="voiceprint_enrollment_quota"):
        begin(actor, expected_version=3)


def test_qwen_signal_only_result_cannot_confirm_or_activate(actor):
    sample = ready(upload(actor, begin(actor)))
    sample.quality = {
        "speech_checked": False,
        "speaker_consistency_checked": False,
        "validation": "signal-only-v1",
        "duration_ms": 3000,
    }
    sample.save()
    assert service.sample_snapshot(sample)["status"] == "quality_pending"
    with pytest.raises(VoiceprintError, match="voiceprint_quality_pending"):
        service.decide(actor, sample.pk, expected_version=1, accepted=True)
    assert sample.profile.status == "pending"
    assert not sample.profile.templates.exists()


def test_reject_destroys_payload_and_stops_job_with_one_way_audit(actor):
    sample = upload(actor, begin(actor))
    service.decide(actor, sample.pk, expected_version=1, accepted=False)
    sample.refresh_from_db()
    assert sample.encrypted_audio == sample.encrypted_embedding == b""
    assert sample.encoding_job.status == "canceled"
    assert (
        service.decide(actor, sample.pk, expected_version=1, accepted=False).status
        == "rejected"
    )
    with pytest.raises(VoiceprintError, match="voiceprint_decision_conflict"):
        service.decide(actor, sample.pk, expected_version=1, accepted=True)


def test_policy_disable_reenable_does_not_restore_old_upload_permit(actor):
    organization = OrganizationFactory(
        settings={"voiceprint": {"enabled": True, "version": 1}}
    )
    MembershipFactory(user=actor, organization=organization)
    consent.update_settings(
        actor,
        organization_id=organization.pk,
        expected_version=0,
        changes={"allow_enrollment": True},
    )
    enrollment = begin(actor, organization_id=organization.pk)
    token = service.enrollment_snapshot(enrollment)["upload_token"]
    organization.settings["voiceprint"]["version"] = 3
    organization.save()
    with pytest.raises(VoiceprintError, match="voiceprint_enrollment_revoked"):
        upload(actor, enrollment, token=token)


def test_missing_enrollment_cannot_restore_upload_clip_authorization(actor):
    enrollment = begin(actor)
    sample = upload(actor, enrollment)
    enrollment.delete()
    sample.refresh_from_db()
    assert sample.enrollment_id is None
    with pytest.raises(VoiceprintError, match="voiceprint_enrollment_revoked"):
        service.sample_audio(actor, sample.pk)


@pytest.mark.parametrize("target", ["account", "consent", "profile"])
def test_cascade_removal_retains_no_biometrics_and_preserves_request_receipt(
    actor, target
):
    enrollment = begin(actor)
    sample = upload(actor, enrollment)
    {"account": actor, "consent": sample.profile.consent, "profile": sample.profile}[
        target
    ].delete()
    assert not models.VoiceprintSample.objects.exists()
    assert not models.VoiceprintEncodingJob.objects.exists()
    enrollment.refresh_from_db()
    assert enrollment.profile_id is None
    assert service.enrollment_snapshot(enrollment)["status"] == "canceled"


@pytest.mark.parametrize("target", [models.VoiceprintConsent, models.VoiceprintSample])
def test_concurrent_removal_during_sample_lock_is_safe_unavailable(
    actor, monkeypatch, target
):
    sample = upload(actor, begin(actor))
    original = QuerySet.first

    def removed(query):
        if query.model is target and query.query.select_for_update:
            return None
        return original(query)

    monkeypatch.setattr(QuerySet, "first", removed)
    with pytest.raises(VoiceprintError, match="voiceprint_sample_unavailable"):
        service.decide(actor, sample.pk, expected_version=1, accepted=False)


def test_database_enforces_slots_and_job_retry_budget(actor):
    sample = upload(actor, begin(actor))
    for invalid_slot in (None, 6):
        with pytest.raises(IntegrityError), transaction.atomic():
            models.VoiceprintSample.objects.filter(pk=sample.pk).update(
                enrollment_slot=invalid_slot
            )
    with pytest.raises(IntegrityError), transaction.atomic():
        models.VoiceprintEncodingJob.objects.filter(sample=sample).update(attempts=4)


@pytest.mark.django_db(transaction=True)
def test_parallel_identical_requests_create_one_receipt_and_one_job():
    actor = UserFactory()
    consent.update_settings(
        actor,
        organization_id=None,
        expected_version=0,
        changes={"allow_enrollment": True},
    )
    request_key = uuid4()

    def request():
        close_old_connections()
        try:
            enrollment = begin(actor, request_key=request_key)
            sample = upload(actor, enrollment)
            return enrollment.pk, sample.pk
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as executor:
        identifiers = list(executor.map(lambda _: request(), range(2)))
    assert identifiers[0] == identifiers[1]
    assert models.VoiceprintEnrollment.objects.count() == 1
    assert models.VoiceprintSample.objects.count() == 1
    assert models.VoiceprintEncodingJob.objects.count() == 1


@pytest.mark.parametrize("slot", [-1, 6, True, None])
def test_invalid_slots_do_not_queue_jobs(actor, slot):
    with pytest.raises(VoiceprintError, match="voiceprint_slot_invalid"):
        upload(actor, begin(actor), slot=slot)
    assert not models.VoiceprintEncodingJob.objects.exists()


@pytest.mark.parametrize(
    "audio",
    [wav(seconds=2), wav(seconds=11), wav(channels=2), wav(rate=16000), b"RIFFbad"],
    ids=["too-short", "too-long", "stereo", "wrong-rate", "malformed"],
)
def test_invalid_audio_cannot_queue_encoding(actor, audio):
    with pytest.raises(VoiceprintError):
        upload(actor, begin(actor), audio=audio)
    assert not models.VoiceprintEncodingJob.objects.exists()


def test_not_owner_and_expired_lease_cannot_upload_or_listen(actor):
    enrollment = begin(actor)
    sample = upload(actor, enrollment)
    stranger = UserFactory()
    with pytest.raises(VoiceprintError, match="voiceprint_enrollment_unavailable"):
        upload(stranger, enrollment)
    with pytest.raises(VoiceprintError, match="voiceprint_sample_unavailable"):
        service.sample_audio(stranger, sample.pk)
    models.VoiceprintEnrollment.objects.filter(pk=enrollment.pk).update(
        expires_at=timezone.now()
    )
    with pytest.raises(VoiceprintError, match="voiceprint_upload_expired"):
        upload(actor, enrollment, slot=1, audio=wav(121))


def test_permission_change_clears_running_lease(actor):
    sample = upload(actor, begin(actor))
    models.VoiceprintEncodingJob.objects.filter(sample=sample).update(
        status="running",
        lease_token=uuid4(),
        lease_until=timezone.now() + timezone.timedelta(minutes=1),
    )
    consent.update_settings(
        actor,
        organization_id=None,
        expected_version=1,
        changes={"allow_enrollment": False},
    )
    sample.encoding_job.refresh_from_db()
    assert sample.encoding_job.status == "canceled"
    assert sample.encoding_job.lease_token is sample.encoding_job.lease_until is None
