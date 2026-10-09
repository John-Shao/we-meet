"""Separate leased quality jobs. Cloud text is never persisted in this queue."""

import hashlib
from dataclasses import dataclass, field
from uuid import uuid4

from django.conf import settings
from django.db import IntegrityError, transaction
from django.db.models import F, Q
from django.utils import timezone

from core import models
from core.services import voiceprint_enrollment as enrollment
from core.services import voiceprint_jobs as encoding
from core.services import voiceprint_quality as quality
from core.services import voiceprint_quality_process as process
from core.services.voiceprint_consent import VoiceprintError
from core.services.voiceprint_crypto import VoiceprintCryptoError, load_keyring
from core.services.voiceprint_encoder import (
    FEATURE_SPACE,
    EncoderError,
    EncoderResult,
    decode_result,
)
from core.services.voiceprint_prompt import challenge_digest, prompt_matches
from core.services.voiceprint_rpc_process import result_payload
from core.services.voiceprint_vectors import read_sample_vector, sample_payload


@dataclass(frozen=True)
class QualityLease:
    job_id: object
    sample_id: object
    token: object
    generation: int
    consent_version: int
    expires_at: object
    duration_ms: int
    source_key: tuple = field(repr=False)
    audio_digest: str = field(repr=False)
    audio_cipher_digest: str = field(repr=False)
    embedding_digest: str = field(repr=False)
    locale: str = field(repr=False)
    prompt: str = field(repr=False)
    wav: bytes = field(repr=False)


def pending_ids(limit):
    now = timezone.now()
    return list(
        models.VoiceprintQualityJob.objects.filter(
            Q(status="queued")
            | Q(status="failed", retryable=True, attempts__lt=3)
            | Q(status="running", lease_until__lte=now)
            | Q(status="running", lease_until__isnull=True)
        )
        .order_by("created_at", "id")
        .values_list("pk", flat=True)[:limit]
    )


def enqueue_ready(limit):
    rows = (
        models.VoiceprintSample.objects.filter(
            status="ready",
            source_type="enrollment",
            expires_at__gt=timezone.now(),
            generation=F("profile__consent__generation"),
            consent_version=F("profile__consent__version"),
            quality__speech_checked=False,
            quality_job__isnull=True,
        )
        .order_by("created_at", "id")
        .values("pk", "expires_at")[:limit]
    )
    created = 0
    for row in list(rows):
        try:
            _, admitted = models.VoiceprintQualityJob.objects.get_or_create(
                sample_id=row["pk"], defaults={"expires_at": row["expires_at"]}
            )
        except IntegrityError:
            continue  # Concurrent sample deletion; no audio has been accessed.
        created += admitted
    return created


def challenge(sample):
    registration = sample.enrollment
    if (
        sample.source_type != "enrollment"
        or registration is None
        or type(sample.enrollment_slot) is not int
        or not 0 <= sample.enrollment_slot < 6
        or not isinstance(registration.challenges, list)
        or len(registration.challenges) != 6
    ):
        raise quality.QualityError("quality_input_invalid")
    prompt = registration.challenges[sample.enrollment_slot]
    if not prompt_matches(prompt, locale=registration.locale, prompt=prompt):
        raise quality.QualityError("quality_input_invalid")
    return registration.locale, prompt


def enabled():
    return (
        settings.MEETING_VOICEPRINT_ENABLED
        and settings.MEETING_VOICEPRINT_QUALITY_ENABLED
    )


def signal_vector(sample, profile, keyring):
    vector = read_sample_vector(
        sample,
        keyring.decrypt(
            profile, sample.encrypted_embedding, kind="embedding", object_id=sample.pk
        ),
    )
    # The quality worker may only promote an actual validated signal-only result,
    # never a cached quality override or a feature from another producer/space.
    return decode_result(
        result_payload(EncoderResult(vector, sample.quality, sample.audio_sha256)),
        sample.audio_sha256,
    ).vector


@transaction.atomic
def claim(identifier):  # noqa: PLR0911, PLR0912 -- Locked state and authorization guards remain explicit.
    if not enabled():
        return None
    locked = encoding.lock_job(identifier, quality=True)
    if locked is None:
        return None
    job, sample = locked
    now = timezone.now()
    if not (
        job.status == "queued"
        or (job.status == "failed" and job.retryable and job.attempts < 3)
        or (
            job.status == "running"
            and (job.lease_until is None or job.lease_until <= now)
        )
    ):
        return None
    if min(job.expires_at, sample.expires_at) <= now:
        encoding.stop(job, status="expired", code="sample_expired")
        if sample.status != "confirmed":
            encoding.discard_sample(sample, "expired")
        return None
    if sample.status not in {"ready", "processing"}:
        encoding.stop(job, status="canceled", code="sample_unavailable")
        return None
    try:
        profile = enrollment.sample_authorized(sample)
    except VoiceprintError:
        encoding.stop(job, status="canceled", code="authorization_revoked")
        encoding.discard_sample(sample, "deleted")
        return None
    if job.attempts >= 3:
        encoding.stop(job, status="failed", code="attempts_exhausted")
        sample.status = "ready"
        sample.save(update_fields=["status", "updated_at"])
        return None
    job.attempts += 1
    try:
        if profile.feature_space != FEATURE_SPACE:
            raise quality.QualityError("quality_input_invalid")
        locale, prompt = challenge(sample)
        keyring = load_keyring()
        wav = keyring.decrypt(
            profile, sample.encrypted_audio, kind="audio", object_id=sample.pk
        )
        duration = quality.audio_duration(wav)
        if (
            hashlib.sha256(wav).hexdigest() != sample.audio_sha256
            or duration != sample.end_ms - sample.start_ms
        ):
            raise quality.QualityError("quality_input_invalid")
        if enrollment.sample_quality_ready(sample):
            read_sample_vector(
                sample,
                keyring.decrypt(
                    profile,
                    sample.encrypted_embedding,
                    kind="embedding",
                    object_id=sample.pk,
                ),
            )
            encoding.stop(job, status="canceled", code="quality_already_checked")
            return None
        signal_vector(sample, profile, keyring)
    except VoiceprintCryptoError:
        encoding.stop(
            job,
            status="failed",
            code="voiceprint_key_unavailable",
            retryable=job.attempts < 3,
        )
        sample.status = "ready"
        sample.save(update_fields=["status", "updated_at"])
        return None
    except (VoiceprintError, EncoderError, quality.QualityError):
        encoding.stop(job, status="failed", code="quality_input_invalid")
        encoding.discard_sample(sample, "rejected")
        return None
    job.status, job.error_code, job.retryable = "running", "", False
    job.lease_token = uuid4()
    job.lease_until = min(
        now + timezone.timedelta(seconds=40), job.expires_at, sample.expires_at
    )
    job.finished_at = None
    job.save()
    sample.status = "processing"
    sample.save(update_fields=["status", "updated_at"])
    return QualityLease(
        job.pk,
        sample.pk,
        job.lease_token,
        sample.generation,
        sample.consent_version,
        job.lease_until,
        duration,
        encoding.source_key(sample),
        sample.audio_sha256,
        hashlib.sha256(bytes(sample.encrypted_audio)).hexdigest(),
        hashlib.sha256(bytes(sample.encrypted_embedding)).hexdigest(),
        locale,
        prompt,
        wav,
    )


def source_matches(sample, lease):
    try:
        return (
            sample.status == "processing"
            and sample.expires_at > timezone.now()
            and sample.generation == lease.generation
            and sample.consent_version == lease.consent_version
            and sample.audio_sha256 == lease.audio_digest
            and sample.end_ms - sample.start_ms == lease.duration_ms
            and encoding.source_key(sample) == lease.source_key
            and challenge(sample) == (lease.locale, lease.prompt)
        )
    except quality.QualityError:
        return False


def authorized(lease):
    if not enabled() or lease.expires_at <= timezone.now():
        return False
    job = (
        models.VoiceprintQualityJob.objects.select_related(
            "sample__enrollment", "sample__profile"
        )
        .defer("sample__encrypted_audio", "sample__encrypted_embedding")
        .filter(
            pk=lease.job_id,
            sample_id=lease.sample_id,
            status="running",
            lease_token=lease.token,
            lease_until__gt=timezone.now(),
            expires_at__gt=timezone.now(),
        )
        .first()
    )
    if job is None or not source_matches(job.sample, lease):
        return False
    try:
        enrollment.sample_authorized(job.sample)
    except VoiceprintError:
        return False
    return True


def unavailable(job, sample, code, *, retryable=False):
    allowed = quality.ERROR_CODES | {"voiceprint_key_unavailable", "lease_expired"}
    code = code if code in allowed else "quality_worker_unavailable"
    encoding.stop(
        job, status="failed", code=code, retryable=retryable and job.attempts < 3
    )
    sample.status = "ready"
    sample.save(update_fields=["status", "updated_at"])
    return False


@transaction.atomic
def finish(lease, *, result=None, error=None):  # noqa: PLR0911 -- Prevent stale quality evidence from changing a sample.
    locked = encoding.lock_job(lease.job_id, quality=True)
    if locked is None:
        return False
    job, sample = locked
    if job.status != "running" or job.lease_token != lease.token:
        return False
    now = timezone.now()
    if min(job.expires_at, sample.expires_at) <= now:
        encoding.stop(job, status="expired", code="sample_expired")
        encoding.discard_sample(sample, "expired")
        return False
    if not enabled():
        return unavailable(job, sample, "quality_authorization_revoked", retryable=True)
    try:
        profile = enrollment.sample_authorized(sample)
    except VoiceprintError:
        encoding.stop(job, status="canceled", code="authorization_revoked")
        encoding.discard_sample(sample, "deleted")
        return False
    if (
        not source_matches(sample, lease)
        or hashlib.sha256(bytes(sample.encrypted_audio)).hexdigest()
        != lease.audio_cipher_digest
        or hashlib.sha256(bytes(sample.encrypted_embedding)).hexdigest()
        != lease.embedding_digest
    ):
        encoding.stop(job, status="canceled", code="source_changed")
        encoding.discard_sample(sample, "rejected")
        return False
    if job.lease_until is None or min(job.lease_until, lease.expires_at) <= now:
        return unavailable(job, sample, "lease_expired", retryable=True)
    if result is None:
        return unavailable(
            job,
            sample,
            str(error),
            retryable=isinstance(error, quality.QualityError) and error.retryable,
        )
    try:
        result = quality.decode_result(
            result,
            digest=lease.audio_digest,
            prompt_digest=challenge_digest(lease.locale, lease.prompt),
            duration=lease.duration_ms,
        )
        keyring = load_keyring()
        vector = signal_vector(sample, profile, keyring)
    except VoiceprintCryptoError:
        return unavailable(job, sample, "voiceprint_key_unavailable", retryable=True)
    except (VoiceprintError, EncoderError, quality.QualityError):
        return unavailable(job, sample, "quality_response_invalid")
    if not result["passed"]:
        sample.quality = {**sample.quality, "quality_rejection": result["reason"]}
        encoding.discard_sample(sample, "rejected")
        sample.save(update_fields=["quality", "updated_at"])
        encoding.stop(job, status="succeeded", code=result["reason"])
        return True
    sample.quality = {
        **sample.quality,
        "speech_checked": True,
        "speaker_consistency_checked": True,
        "valid_speech_ms": result["valid_speech_ms"],
        "speech_validation": quality.POLICY_VERSION,
        "asr_model_id": quality.MODEL_ID,
        "prompt_checked": True,
        "prompt_sha256": result["prompt_sha256"],
        "speaker_count": 1,
    }
    try:
        sample.encrypted_embedding = keyring.encrypt(
            profile,
            sample_payload(sample, vector),
            kind="embedding",
            object_id=sample.pk,
        )
    except VoiceprintCryptoError:
        return unavailable(job, sample, "voiceprint_key_unavailable", retryable=True)
    sample.status = "ready"
    sample.save(
        update_fields=["quality", "encrypted_embedding", "status", "updated_at"]
    )
    encoding.stop(job, status="succeeded")
    return True


def process_one(identifier, config):
    if enabled():
        config.validate()
    lease = claim(identifier)
    if lease:
        try:
            result = process.extract(
                lease.wav,
                config=config,
                locale=lease.locale,
                prompt=lease.prompt,
                expires=int(lease.expires_at.timestamp()),
                authorized=lambda: authorized(lease),
            )
        except quality.QualityError as error:
            finish(lease, error=error)
        except Exception:  # noqa: BLE001 -- Persist only a fixed failure code after child cleanup.
            finish(
                lease,
                error=quality.QualityError(
                    "quality_worker_unavailable", retryable=True
                ),
            )
        else:
            finish(lease, result=result)
    return (
        models.VoiceprintQualityJob.objects.filter(pk=identifier)
        .values_list("status", flat=True)
        .first()
        or "skipped"
    )
