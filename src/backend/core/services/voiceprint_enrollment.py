"""Owner-bound registration admission and private clips; no inferred enrollment."""

import base64
import hashlib
import hmac
import io
import secrets
import struct
import wave
from uuid import uuid4

from django.db import transaction
from django.utils import timezone

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from core import models
from core.services import voiceprint_consent as consent_service
from core.services.voiceprint_consent import VoiceprintError
from core.services.voiceprint_crypto import (
    VoiceprintCryptoError,
    load_keyring,
    scope_aad,
)
from core.services.voiceprint_encoder import MAX_AUDIO_BYTES
from core.services.voiceprint_prompt import challenge_digest
from core.services.voiceprint_quality import CALL_POLICY_VERSION
from core.services.voiceprint_quality import MODEL_ID as QUALITY_MODEL_ID
from core.services.voiceprint_quality import POLICY_VERSION as QUALITY_POLICY
from core.services.voiceprint_vectors import read_sample_vector

MAX_CLIPS = 6
MAX_ENROLLMENTS_PER_24H = 3
UPLOAD_MINUTES = 10
CANDIDATE_HOURS = 24
PROMPTS = {
    "en": "This is my voice sample. My numbers are: {numbers}.",
    "zh-CN": "这是我的声纹样本。本次数字为：{numbers}。",
    "fr": "Ceci est mon échantillon vocal. Voici mes nombres : {numbers}.",
    "de": "Das ist meine Stimmprobe. Meine Zahlen sind: {numbers}.",
    "nl": "Dit is mijn stemvoorbeeld. Mijn getallen zijn: {numbers}.",
}


def normalize_wav(wav):
    """Structural ingress check only; it does not certify speech or one speaker."""
    if not isinstance(wav, bytes) or not 1 <= len(wav) <= MAX_AUDIO_BYTES:
        raise VoiceprintError("voiceprint_audio_size_invalid", status=413)
    try:
        if wav[:4] != b"RIFF" or wav[8:12] != b"WAVE" or len(wav) < 44:
            raise ValueError
        if struct.unpack_from("<I", wav, 4)[0] != len(wav) - 8:
            raise ValueError
        chunks = {}
        offset = 12
        while offset < len(wav):
            if offset + 8 > len(wav):
                raise ValueError
            name = wav[offset : offset + 4]
            length = struct.unpack_from("<I", wav, offset + 4)[0]
            start = offset + 8
            offset = start + length + (length % 2)
            if offset > len(wav):
                raise ValueError
            if name in {b"fmt ", b"data"}:
                if name in chunks:
                    raise ValueError
                chunks[name] = wav[start : start + length]
        fmt = chunks.get(b"fmt ", b"")
        if len(fmt) not in {16, 18} or struct.unpack_from("<HHIIHH", fmt) != (
            1,
            1,
            24000,
            48000,
            2,
            16,
        ):
            raise ValueError
        if len(fmt) == 18 and fmt[16:] != b"\x00\x00":
            raise ValueError
        with wave.open(io.BytesIO(wav), "rb") as stream:
            frames = stream.getnframes()
            pcm = stream.readframes(frames + 1) if 72000 <= frames <= 240000 else b""
            if (
                stream.getnchannels() != 1
                or stream.getsampwidth() != 2
                or stream.getframerate() != 24000
                or stream.getcomptype() != "NONE"
                or not 72000 <= frames <= 240000
                or len(pcm) != frames * 2
                or chunks.get(b"data") != pcm
            ):
                raise ValueError
    except (EOFError, OSError, ValueError, RuntimeError, struct.error, wave.Error):
        raise VoiceprintError("voiceprint_wav_invalid", status=422) from None
    # Strip metadata before hashing so container changes cannot manufacture
    # additional evidence from an identical PCM recording.
    canonical = io.BytesIO()
    with wave.open(canonical, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(24000)
        writer.writeframes(pcm)
    return canonical.getvalue(), frames * 1000 // 24000


def wav_duration(wav):
    return normalize_wav(wav)[1]


def upload_token(enrollment, profile):
    # Domain-separated token key, recovered only from the current profile key.
    key = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=None,
        info=b"we-meet-enrollment-upload-v1",
    ).derive(load_keyring().profile_key(profile))
    value = hmac.digest(
        key, scope_aad(profile, kind="enrollment", object_id=enrollment.pk), "sha256"
    )
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def authorized_enrollment(enrollment):
    enrollment = models.VoiceprintEnrollment.objects.filter(pk=enrollment.pk).first()
    if enrollment is None:
        raise VoiceprintError("voiceprint_enrollment_revoked")
    if enrollment.profile_id is None or enrollment.status == "canceled":
        raise VoiceprintError("voiceprint_enrollment_revoked")
    profile = consent_service.authorize_profile(
        enrollment.profile_id,
        permission="allow_enrollment",
        version=enrollment.consent_version,
        generation=enrollment.generation,
    )
    if (
        profile.consent.user_id != enrollment.owner_id
        or profile.consent.organization_id != enrollment.organization_id
        or (
            consent_service.organization_policy(profile.consent.organization)["version"]
            if profile.consent.organization_id
            else 0
        )
        != enrollment.policy_version
    ):
        raise VoiceprintError("voiceprint_enrollment_revoked")
    return profile


def enrollment_snapshot(enrollment):
    result = {
        "id": str(enrollment.pk),
        "organization_id": str(enrollment.organization_id)
        if enrollment.organization_id
        else None,
        "profile_id": str(enrollment.profile_id) if enrollment.profile_id else None,
        "status": enrollment.status,
        "expires_at": enrollment.expires_at.isoformat(),
        "consent_version": enrollment.consent_version,
        "generation": enrollment.generation,
        "challenges": enrollment.challenges,
        "max_clips": MAX_CLIPS,
        "uploaded_slots": list(
            enrollment.samples.order_by("enrollment_slot").values_list(
                "enrollment_slot", flat=True
            )
        ),
        "sample_rate": 24000,
        "channels": 1,
        "format": "pcm16_wav",
        "clip_duration_ms": {"minimum": 3000, "maximum": 10000},
        "upload_token": None,
    }
    if enrollment.status != "canceled":
        try:
            profile = authorized_enrollment(enrollment)
        except VoiceprintError:
            result["status"] = "canceled"
        else:
            if enrollment.status == "open":
                if enrollment.expires_at > timezone.now():
                    result["upload_token"] = upload_token(enrollment, profile)
                else:
                    result["status"] = "expired"
    return result


@transaction.atomic
def begin(actor, *, organization_id, expected_version, request_key, locale):
    user = consent_service.owner(actor, lock=True)
    if type(expected_version) is not int or expected_version < 1:
        raise VoiceprintError("voiceprint_settings_invalid", status=400)
    previous = models.VoiceprintEnrollment.objects.filter(
        owner_id=user.pk, request_key=request_key
    ).first()
    if previous:
        if (
            previous.organization_id != organization_id
            or previous.consent_version != expected_version
            or previous.locale != locale
        ):
            raise VoiceprintError("voiceprint_request_conflict", status=409)
        return previous
    if locale not in PROMPTS:
        raise VoiceprintError("voiceprint_locale_invalid", status=400)
    if (
        models.VoiceprintEnrollment.objects.filter(
            owner_id=user.pk,
            created_at__gt=timezone.now() - timezone.timedelta(hours=24),
        ).count()
        >= MAX_ENROLLMENTS_PER_24H
    ):
        raise VoiceprintError("voiceprint_enrollment_quota", status=429)
    profile = consent_service.ensure_profile(
        user, organization_id=organization_id, expected_version=expected_version
    )
    return models.VoiceprintEnrollment.objects.create(
        owner_id=user.pk,
        organization_id=organization_id,
        profile=profile,
        request_key=request_key,
        consent_version=profile.consent.version,
        generation=profile.generation,
        policy_version=consent_service.organization_policy(
            profile.consent.organization
        )["version"]
        if organization_id
        else 0,
        locale=locale,
        challenges=[
            PROMPTS[locale].format(
                numbers=" · ".join(str(secrets.randbelow(90) + 10) for _ in range(6))
            )
            for _ in range(MAX_CLIPS)
        ],
        expires_at=timezone.now() + timezone.timedelta(minutes=UPLOAD_MINUTES),
    )


@transaction.atomic
def upload(actor, *, enrollment_id, slot, token, wav):
    user = consent_service.owner(actor, lock=True)
    enrollment = models.VoiceprintEnrollment.objects.filter(
        pk=enrollment_id, owner_id=user.pk
    ).first()
    if enrollment is None:
        raise VoiceprintError("voiceprint_enrollment_unavailable", status=404)
    # Match lock order to consent edits/offboarding before locking the receipt.
    consent_service.scope(user, enrollment.organization_id, lock=True)
    if enrollment.profile_id is None:
        raise VoiceprintError("voiceprint_enrollment_revoked")
    consent = (
        models.VoiceprintConsent.objects.select_for_update(of=("self",))
        .filter(profiles=enrollment.profile_id)
        .first()
    )
    if consent is None:
        raise VoiceprintError("voiceprint_enrollment_revoked")
    enrollment = (
        models.VoiceprintEnrollment.objects.select_for_update()
        .filter(pk=enrollment.pk)
        .first()
    )
    if enrollment is None:
        raise VoiceprintError("voiceprint_enrollment_unavailable", status=404)
    profile = authorized_enrollment(enrollment)
    if enrollment.expires_at <= timezone.now():
        raise VoiceprintError("voiceprint_upload_expired", status=410)
    if type(slot) is not int or not 0 <= slot < MAX_CLIPS:
        raise VoiceprintError("voiceprint_slot_invalid", status=400)
    if (
        not isinstance(token, str)
        or len(token) != 43
        or not token.isascii()
        or not hmac.compare_digest(token, upload_token(enrollment, profile))
    ):
        raise VoiceprintError("voiceprint_upload_denied")
    wav, duration = normalize_wav(wav)
    digest = hashlib.sha256(wav).hexdigest()
    previous = enrollment.samples.filter(enrollment_slot=slot).first()
    if previous:
        if previous.audio_sha256 != digest:
            raise VoiceprintError("voiceprint_request_conflict", status=409)
        return previous
    if enrollment.status != "open":
        raise VoiceprintError("voiceprint_upload_closed", status=409)
    if profile.samples.filter(
        generation=profile.generation, audio_sha256=digest
    ).exists():
        raise VoiceprintError("voiceprint_duplicate_audio", status=409)
    identifier = uuid4()
    sample = models.VoiceprintSample.objects.create(
        id=identifier,
        profile=profile,
        generation=profile.generation,
        consent_version=consent.version,
        permit_id=enrollment.pk,
        enrollment=enrollment,
        enrollment_slot=slot,
        source_type="enrollment",
        end_ms=duration,
        audio_sha256=digest,
        encrypted_audio=load_keyring().encrypt(
            profile, wav, kind="audio", object_id=identifier
        ),
        expires_at=timezone.now() + timezone.timedelta(hours=CANDIDATE_HOURS),
    )
    models.VoiceprintEncodingJob.objects.create(
        sample=sample, expires_at=sample.expires_at
    )
    if enrollment.samples.count() >= MAX_CLIPS:
        enrollment.status = "closed"
        enrollment.save(update_fields=["status", "updated_at"])
    return sample


def has_payload(sample, kind):
    present = getattr(sample, f"{kind}_present", None)
    return (
        present if present is not None else bool(getattr(sample, f"encrypted_{kind}"))
    )


def sample_quality_ready(sample):
    quality = sample.quality
    return (
        has_payload(sample, "embedding")
        and isinstance(quality, dict)
        and quality.get("speech_checked") is True
        and quality.get("speaker_consistency_checked") is True
        and quality.get("speech_validation")
        == (CALL_POLICY_VERSION if sample.source_type == "call" else QUALITY_POLICY)
        and quality.get("asr_model_id") == QUALITY_MODEL_ID
        and type(quality.get("speaker_count")) is int
        and quality["speaker_count"] == 1
        and (sample.source_type != "enrollment" or prompt_quality_ready(sample))
        and type(quality.get("valid_speech_ms")) is int
        and 3000
        <= quality["valid_speech_ms"]
        <= min(10000, sample.end_ms - sample.start_ms)
    )


def prompt_quality_ready(sample):
    registration = sample.enrollment
    return (
        registration is not None
        and type(sample.enrollment_slot) is int
        and 0 <= sample.enrollment_slot < 6
        and isinstance(registration.challenges, list)
        and len(registration.challenges) == 6
        and isinstance(registration.challenges[sample.enrollment_slot], str)
        and sample.quality.get("prompt_checked") is True
        and sample.quality.get("prompt_sha256")
        == challenge_digest(
            registration.locale, registration.challenges[sample.enrollment_slot]
        )
    )


def sample_snapshot(sample):
    quality_pending = sample.status == "ready" and not sample_quality_ready(sample)
    try:
        profile = sample_authorized(sample)
    except VoiceprintError:
        accessible = False
    else:
        accessible = sample.expires_at > timezone.now() and sample.status not in {
            "rejected",
            "expired",
            "deleted",
        }
    can_confirm = accessible and profile.consent.allow_enrollment
    return {
        "id": str(sample.pk),
        "profile_id": str(sample.profile_id),
        "status": "quality_pending" if quality_pending else sample.status,
        "source_type": sample.source_type,
        "duration_ms": sample.end_ms - sample.start_ms,
        "expires_at": sample.expires_at.isoformat(),
        "confirmable": can_confirm
        and has_payload(sample, "audio")
        and sample.status == "ready"
        and sample_quality_ready(sample),
        "audio_available": accessible and has_payload(sample, "audio"),
    }


def owned_sample(actor, identifier):
    user = consent_service.owner(actor)
    sample = (
        models.VoiceprintSample.objects.select_related("profile__consent")
        .filter(pk=identifier, profile__consent__user=user)
        .first()
    )
    if sample is None:
        raise VoiceprintError("voiceprint_sample_unavailable", status=404)
    return sample


def sample_authorized(sample):
    if sample.source_type == "enrollment" and sample.enrollment_id is None:
        raise VoiceprintError("voiceprint_enrollment_revoked")
    profile = consent_service.authorize_profile(
        sample.profile_id,
        permission="allow_enrollment"
        if sample.source_type == "enrollment"
        else "allow_accumulation",
        version=sample.consent_version,
        generation=sample.generation,
    )
    if sample.source_type == "call":
        from core.services.voiceprint_sampling import (  # noqa: PLC0415 -- Trusted call provenance is separate from registration.
            authorized_sample,
        )

        authorized_sample(sample, profile)
    if sample.enrollment_id:
        admitted = authorized_enrollment(sample.enrollment)
        if (
            admitted.pk != profile.pk
            or sample.source_type != "enrollment"
            or sample.permit_id != sample.enrollment_id
        ):
            raise VoiceprintError("voiceprint_enrollment_revoked")
    return profile


def confirmation_authorized(sample):
    profile = sample_authorized(sample)
    # Accumulation may admit a call candidate, but it never grants permission
    # to establish/confirm a voiceprint on its own.
    if not profile.consent.allow_enrollment:
        raise VoiceprintError("voiceprint_enrollment_denied")
    return profile


def locked_sample(actor, identifier):
    """Keep reads/decisions in the same lock order as consent and offboarding."""
    user = consent_service.owner(actor, lock=True)
    initial = owned_sample(user, identifier)
    consent_service.scope(user, initial.profile.consent.organization_id, lock=True)
    consent = (
        models.VoiceprintConsent.objects.select_for_update()
        .filter(pk=initial.profile.consent_id)
        .first()
    )
    if consent is None:
        raise VoiceprintError("voiceprint_sample_unavailable", status=404)
    profile = (
        models.VoiceprintProfile.objects.select_for_update()
        .filter(pk=initial.profile_id, consent=consent)
        .first()
    )
    sample = (
        models.VoiceprintSample.objects.select_for_update()
        .filter(pk=identifier, profile=profile)
        .first()
        if profile
        else None
    )
    if sample is None:
        raise VoiceprintError("voiceprint_sample_unavailable", status=404)
    profile.consent = consent
    sample.profile = profile
    return user, consent, sample


@transaction.atomic
def sample_audio(actor, identifier):
    _, _, sample = locked_sample(actor, identifier)
    profile = sample_authorized(sample)
    if (
        sample.expires_at <= timezone.now()
        or not sample.encrypted_audio
        or sample.status in {"rejected", "expired", "deleted"}
    ):
        raise VoiceprintError("voiceprint_audio_unavailable", status=410)
    clear = load_keyring().decrypt(
        profile, sample.encrypted_audio, kind="audio", object_id=sample.pk
    )
    if hashlib.sha256(clear).hexdigest() != sample.audio_sha256:
        raise VoiceprintError("voiceprint_audio_unavailable", status=410)
    sample_authorized(sample)
    if sample.expires_at <= timezone.now():
        raise VoiceprintError("voiceprint_audio_unavailable", status=410)
    return clear


def cancel_sample_work(sample):
    now = timezone.now()
    for job_model in (models.VoiceprintEncodingJob, models.VoiceprintQualityJob):
        job_model.objects.filter(sample=sample).update(
            status="canceled",
            lease_token=None,
            lease_until=None,
            retryable=False,
            finished_at=now,
            updated_at=now,
        )


@transaction.atomic
def decide(actor, identifier, *, expected_version, accepted):
    user, consent, sample = locked_sample(actor, identifier)
    if type(accepted) is not bool:
        raise VoiceprintError("voiceprint_decision_invalid", status=400)
    if type(expected_version) is not int or expected_version < 1:
        raise VoiceprintError("voiceprint_settings_invalid", status=400)
    if consent.version != expected_version:
        raise VoiceprintError("voiceprint_settings_changed", status=409)
    previous = models.VoiceprintSampleDecision.objects.filter(sample=sample).first()
    if previous:
        if previous.accepted != accepted:
            raise VoiceprintError("voiceprint_decision_conflict", status=409)
        if accepted:
            confirmation_authorized(sample)
        return sample
    if accepted:
        profile = confirmation_authorized(sample)
        if sample.expires_at <= timezone.now() or not sample.encrypted_audio:
            raise VoiceprintError("voiceprint_sample_expired", status=410)
        if sample.status != "ready" or not sample_quality_ready(sample):
            raise VoiceprintError("voiceprint_quality_pending", status=409)
        try:
            read_sample_vector(
                sample,
                load_keyring().decrypt(
                    profile,
                    sample.encrypted_embedding,
                    kind="embedding",
                    object_id=sample.pk,
                ),
            )
        except (VoiceprintError, VoiceprintCryptoError):
            raise VoiceprintError("voiceprint_quality_pending", status=409) from None
        sample.status = "confirmed"
        sample.confirmed_at = timezone.now()
    else:
        if sample.status in {"confirmed", "deleted", "expired"}:
            raise VoiceprintError("voiceprint_decision_conflict", status=409)
        sample.status = "rejected"
        sample.encrypted_audio = sample.encrypted_embedding = b""
        cancel_sample_work(sample)
    sample.save()
    models.VoiceprintSampleDecision.objects.create(
        sample=sample,
        owner_id=user.pk,
        accepted=accepted,
        consent_version=consent.version,
        generation=sample.generation,
    )
    # Confirmation records ownership only. Template creation/activation requires
    # sufficient validated clips and a separate worker; never turn on accumulation.
    return sample
