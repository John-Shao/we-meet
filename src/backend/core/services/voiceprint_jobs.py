"""Independent enrollment queue: lease, killable RPC, reauthorization, encrypted result."""

import hashlib
import struct
from dataclasses import dataclass, field
from uuid import uuid4

from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from core import models
from core.services import voiceprint_enrollment as enrollment
from core.services import voiceprint_rpc_process as rpc_process
from core.services.voiceprint_consent import VoiceprintError
from core.services.voiceprint_crypto import VoiceprintCryptoError, load_keyring
from core.services.voiceprint_encoder import FEATURE_SPACE, EncoderError, decode_result

LEASE_SECONDS = rpc_process.MAX_PROCESS_SECONDS + 5


@dataclass(frozen=True)
class EncodingLease:
    job_id: object
    sample_id: object
    token: object
    generation: int
    consent_version: int
    expires_at: object
    duration_ms: int
    source_key: tuple = field(repr=False)
    audio_digest: str = field(repr=False)
    cipher_digest: str = field(repr=False)
    wav: bytes = field(repr=False)


def source_key(sample):
    return (
        sample.profile_id,
        sample.profile.consent_id,
        sample.source_type,
        sample.source_record_id,
        sample.source_session_id,
        sample.source_track,
        sample.start_ms,
        sample.end_ms,
        sample.enrollment_id,
        sample.enrollment_slot,
        sample.permit_id,
    )


def pending_ids(limit):
    now = timezone.now()
    return list(
        models.VoiceprintEncodingJob.objects.filter(
            Q(status="queued")
            | Q(status="failed", retryable=True, attempts__lt=3)
            | Q(status="running", lease_until__lte=now)
            | Q(status="running", lease_until__isnull=True)
        )
        .order_by("created_at", "id")
        .values_list("pk", flat=True)[:limit]
    )


def lock_job(identifier):  # noqa: PLR0911 -- Explicit ordered lock failures.
    """Same lock order as owner edits; skip a busy scope instead of holding a queue lock."""
    initial = (
        models.VoiceprintEncodingJob.objects.filter(pk=identifier)
        .values(
            "sample_id",
            "sample__profile_id",
            "sample__profile__consent_id",
            "sample__profile__consent__user_id",
            "sample__profile__consent__organization_id",
        )
        .first()
    )
    if initial is None:
        return None
    user = (
        models.User.objects.select_for_update(skip_locked=True)
        .filter(pk=initial["sample__profile__consent__user_id"])
        .first()
    )
    if user is None:
        return None
    org_id = initial["sample__profile__consent__organization_id"]
    organization = (
        models.Organization.objects.select_for_update(skip_locked=True)
        .filter(pk=org_id)
        .first()
        if org_id
        else None
    )
    if org_id and organization is None:
        return None
    consent = (
        models.VoiceprintConsent.objects.select_for_update(skip_locked=True)
        .filter(
            pk=initial["sample__profile__consent_id"],
            user=user,
            organization=organization,
        )
        .first()
    )
    if consent is None:
        return None
    profile = (
        models.VoiceprintProfile.objects.select_for_update(skip_locked=True)
        .filter(pk=initial["sample__profile_id"], consent=consent)
        .first()
    )
    if profile is None:
        return None
    sample = (
        models.VoiceprintSample.objects.select_for_update(skip_locked=True)
        .filter(pk=initial["sample_id"], profile=profile)
        .first()
    )
    if sample is None:
        return None
    job = (
        models.VoiceprintEncodingJob.objects.select_for_update(skip_locked=True)
        .filter(pk=identifier, sample=sample)
        .first()
    )
    if job is None:
        return None
    consent.user = user
    consent.organization = organization
    profile.consent = consent
    sample.profile = profile
    return job, sample


def stop(job, *, status, code="", retryable=False):
    job.status = status
    job.error_code = code
    job.retryable = retryable
    job.lease_token = job.lease_until = None
    job.finished_at = timezone.now()
    job.save()


def discard_sample(sample, status):
    if sample.status not in {"confirmed", "deleted", "expired", "rejected"}:
        sample.status = status
    sample.encrypted_audio = sample.encrypted_embedding = b""
    sample.save(
        update_fields=["status", "encrypted_audio", "encrypted_embedding", "updated_at"]
    )


@transaction.atomic
def claim(identifier):  # noqa: PLR0911 -- Each invalid state ends a locked transition.
    locked = lock_job(identifier)
    if locked is None:
        return None
    job, sample = locked
    now = timezone.now()
    eligible = (
        job.status == "queued"
        or (job.status == "failed" and job.retryable and job.attempts < 3)
        or (
            job.status == "running"
            and (job.lease_until is None or job.lease_until <= now)
        )
    )
    if not eligible:
        return None
    if min(job.expires_at, sample.expires_at) <= now:
        stop(job, status="expired", code="sample_expired")
        discard_sample(sample, "expired")
        return None
    if sample.status not in {"pending", "processing"}:
        stop(job, status="canceled", code="sample_unavailable")
        return None
    try:
        profile = enrollment.sample_authorized(sample)
    except VoiceprintError:
        stop(job, status="canceled", code="authorization_revoked")
        discard_sample(sample, "deleted")
        return None
    if job.attempts >= 3:
        stop(job, status="failed", code="attempts_exhausted")
        discard_sample(sample, "rejected")
        return None
    if profile.feature_space != FEATURE_SPACE:
        stop(job, status="failed", code="feature_space_mismatch")
        discard_sample(sample, "rejected")
        return None
    job.attempts += 1
    try:
        wav = load_keyring().decrypt(
            profile, sample.encrypted_audio, kind="audio", object_id=sample.pk
        )
    except VoiceprintCryptoError:
        stop(
            job,
            status="failed",
            code="voiceprint_key_unavailable",
            retryable=job.attempts < 3,
        )
        return None
    if hashlib.sha256(wav).hexdigest() != sample.audio_sha256:
        stop(job, status="failed", code="audio_digest_mismatch")
        discard_sample(sample, "rejected")
        return None
    token = uuid4()
    job.status, job.error_code, job.retryable = "running", "", False
    job.lease_token = token
    job.lease_until = min(
        now + timezone.timedelta(seconds=LEASE_SECONDS),
        job.expires_at,
        sample.expires_at,
    )
    job.finished_at = None
    job.save()
    sample.status = "processing"
    sample.save(update_fields=["status", "updated_at"])
    return EncodingLease(
        job.pk,
        sample.pk,
        token,
        sample.generation,
        sample.consent_version,
        job.lease_until,
        sample.end_ms - sample.start_ms,
        source_key(sample),
        sample.audio_sha256,
        hashlib.sha256(bytes(sample.encrypted_audio)).hexdigest(),
        wav,
    )


def authorized(lease):
    if lease.expires_at <= timezone.now():
        return False
    job = (
        models.VoiceprintEncodingJob.objects.select_related(
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
    if job is None:
        return False
    sample = job.sample
    if (
        sample.status != "processing"
        or sample.expires_at <= timezone.now()
        or sample.generation != lease.generation
        or sample.consent_version != lease.consent_version
        or sample.audio_sha256 != lease.audio_digest
        or sample.end_ms - sample.start_ms != lease.duration_ms
        or source_key(sample) != lease.source_key
    ):
        return False
    try:
        enrollment.sample_authorized(sample)
    except VoiceprintError:
        return False
    return True


@transaction.atomic
def finish(lease, *, result=None, error=None):  # noqa: PLR0911, PLR0912 -- Keep commit guards explicit.
    locked = lock_job(lease.job_id)
    if locked is None:
        return False
    job, sample = locked
    if job.status != "running" or job.lease_token != lease.token:
        return False
    now = timezone.now()
    if min(job.expires_at, sample.expires_at) <= now:
        stop(job, status="expired", code="sample_expired")
        discard_sample(sample, "expired")
        return False
    if job.lease_until is None or min(job.lease_until, lease.expires_at) <= now:
        stop(job, status="failed", code="lease_expired", retryable=job.attempts < 3)
        if job.attempts < 3:
            sample.status = "pending"
            sample.save(update_fields=["status", "updated_at"])
        else:
            discard_sample(sample, "rejected")
        return False
    try:
        profile = enrollment.sample_authorized(sample)
    except VoiceprintError:
        stop(job, status="canceled", code="authorization_revoked")
        discard_sample(sample, "deleted")
        return False
    if (
        sample.pk != lease.sample_id
        or sample.status != "processing"
        or sample.generation != lease.generation
        or sample.consent_version != lease.consent_version
        or sample.audio_sha256 != lease.audio_digest
        or sample.end_ms - sample.start_ms != lease.duration_ms
        or source_key(sample) != lease.source_key
        or hashlib.sha256(bytes(sample.encrypted_audio)).hexdigest()
        != lease.cipher_digest
        or profile.feature_space != FEATURE_SPACE
    ):
        stop(job, status="canceled", code="source_changed")
        discard_sample(sample, "rejected")
        return False
    if result is not None:
        try:
            result = decode_result(
                rpc_process.result_payload(result), lease.audio_digest
            )
            if result.quality["duration_ms"] != lease.duration_ms:
                raise EncoderError("encoder_response_invalid")
            sample.encrypted_embedding = load_keyring().encrypt(
                profile,
                struct.pack("<1024f", *result.vector),
                kind="embedding",
                object_id=sample.pk,
            )
        except EncoderError as failure:
            error, result = failure, None
        except VoiceprintCryptoError:
            error, result = (
                EncoderError("voiceprint_key_unavailable", retryable=True),
                None,
            )
    if result is None:
        retry = bool(error and error.retryable and job.attempts < 3)
        code = str(error) if isinstance(error, EncoderError) else "encoding_unavailable"
        allowed = rpc_process.ERROR_CODES | {
            "voiceprint_key_unavailable",
            "encoding_unavailable",
            "encoder_authorization_revoked",
            "encoder_worker_unavailable",
        }
        stop(
            job,
            status="canceled" if code == "encoder_authorization_revoked" else "failed",
            code=code if code in allowed else "encoding_unavailable",
            retryable=retry,
        )
        if retry:
            sample.status = "pending"
            sample.save(update_fields=["status", "updated_at"])
        else:
            discard_sample(sample, "rejected")
        return False
    sample.quality = result.quality
    sample.status = "ready"
    sample.save(
        update_fields=["quality", "status", "encrypted_embedding", "updated_at"]
    )
    stop(job, status="succeeded")
    return True


def process_one(identifier, config):
    lease = claim(identifier)
    if lease:
        try:
            result = rpc_process.extract(
                lease.wav,
                config=config,
                job_id=lease.job_id,
                lease_expires_at=int(lease.expires_at.timestamp()),
                authorized=lambda: authorized(lease),
            )
        except EncoderError as error:
            finish(lease, error=error)
        except Exception:  # noqa: BLE001 -- Reap child first, then persist only a fixed failure code.
            finish(
                lease, error=EncoderError("encoder_worker_unavailable", retryable=True)
            )
        else:
            finish(lease, result=result)
    return (
        models.VoiceprintEncodingJob.objects.filter(pk=identifier)
        .values_list("status", flat=True)
        .first()
        or "skipped"
    )
