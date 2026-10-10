"""Independent identity queue and atomic, versioned suggestion publication.

One job handles one published source speaker. Record-level submission may fan
out into these bounded jobs; no ASR task or human attribution is changed here.
"""

from dataclasses import dataclass, field
from uuid import UUID, uuid4

from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from core import models
from core.services import voiceprint_candidates as candidates
from core.services import voiceprint_matching as matching
from core.services import voiceprint_query_producer as producer
from core.services import voiceprint_source_intervals as intervals
from core.services import voiceprint_sources as sources
from core.services.voiceprint_consent import VoiceprintError
from core.services.voiceprint_encoder import FEATURE_SPACE
from core.services.voiceprint_media_process import MediaError

MAX_ATTEMPTS = 3
LEASE_SECONDS = 900


@dataclass(frozen=True)
class IdentityLease:
    job_id: UUID
    token: UUID = field(repr=False)
    speaker_id: UUID = field(repr=False)
    source: sources.SourceSnapshot = field(repr=False)
    pool: candidates.CandidatePool = field(repr=False)
    policy: object = field(repr=False)
    expires_at: object


def policy():
    from django.conf import settings  # noqa: PLC0415 -- Runtime configuration.

    value = matching.load_policy(settings.MEETING_VOICEPRINT_THRESHOLD_CONFIG_FILE)
    if not value.calibrated:
        raise VoiceprintError("voiceprint_calibration_required", status=503)
    return value


def lock_scope(actor_id, identifiers, organization_id):
    """Use the enrollment/template order: subjects, organization, consent, profile.

    Subject locks prevent consent creation phantoms as well as concurrent
    revocation; profile locks serialize rebuilding active template artifacts.
    No provider or network call is made while any of these locks are held.
    """
    list(
        models.User.objects.select_for_update()
        .filter(pk__in=set(identifiers) | {actor_id})
        .order_by("pk")
        .values_list("pk", flat=True)
    )
    if organization_id:
        models.Organization.objects.select_for_update().filter(
            pk=organization_id
        ).first()
    list(
        models.VoiceprintConsent.objects.select_for_update()
        .filter(user_id__in=identifiers, organization_id=organization_id)
        .order_by("pk")
        .values_list("pk", flat=True)
    )
    list(
        models.VoiceprintProfile.objects.select_for_update()
        .filter(
            consent__user_id__in=identifiers, consent__organization_id=organization_id
        )
        .order_by("pk")
        .values_list("pk", flat=True)
    )


def context(job):
    if job.requester_id is None or job.feature_space != FEATURE_SPACE:
        raise VoiceprintError("voiceprint_identity_context_changed", status=409)
    frozen_policy = policy()
    if frozen_policy.digest != job.threshold_digest:
        raise VoiceprintError("voiceprint_identity_context_changed", status=409)
    record = models.MeetingRecord(pk=job.record_id)
    actor = models.User(pk=job.requester_id)
    source = sources.snapshot(record, actor, expected_revision=job.record_revision)
    pool = candidates.load_pool(
        record,
        actor,
        organization_id=job.organization_id,
        user_ids=job.requested_users,
        expected_revision=job.record_revision,
    )
    if (
        source.fingerprint != job.source_digest
        or pool.fingerprint != job.candidate_digest
        or job.speaker_id not in {row.speaker_id for row in source.intervals}
        or len(pool.requested) > frozen_policy.max_candidates
    ):
        raise VoiceprintError("voiceprint_identity_context_changed", status=409)
    return source, pool, frozen_policy


@transaction.atomic
def enqueue(  # noqa: PLR0913 -- Explicit record/speaker, source revision and selected scope.
    record,
    actor,
    *,
    speaker_id,
    organization_id,
    user_ids,
    expected_revision,
    request_key,
):
    if not isinstance(speaker_id, UUID) or not isinstance(request_key, UUID):
        raise VoiceprintError("voiceprint_identity_request_invalid", status=400)
    identifiers = candidates.explicit_ids(user_ids)
    organization_id = candidates.explicit_scope(organization_id)
    lock_scope(actor.pk, identifiers, organization_id)
    locked = (
        models.MeetingRecord.objects.select_for_update().filter(pk=record.pk).first()
    )
    if locked is None:
        raise VoiceprintError("voiceprint_record_unavailable", status=404)
    frozen_policy = policy()
    if len(identifiers) > frozen_policy.max_candidates:
        raise VoiceprintError("voiceprint_candidates_invalid", status=400)
    source = sources.snapshot(locked, actor, expected_revision=expected_revision)
    pool = candidates.load_pool(
        locked,
        actor,
        organization_id=organization_id,
        user_ids=identifiers,
        expected_revision=expected_revision,
    )
    if speaker_id not in {row.speaker_id for row in source.intervals}:
        raise VoiceprintError("voiceprint_source_speaker_unavailable", status=404)
    intent = sources.digest(
        {
            "actor": str(actor.pk),
            "source": source.fingerprint,
            "speaker": str(speaker_id),
            "candidate": pool.fingerprint,
            "threshold": frozen_policy.digest,
            "space": FEATURE_SPACE,
        }
    )
    previous = models.SpeakerIdentityJob.objects.filter(
        record=locked, speaker_id=speaker_id, request_key=request_key
    ).first()
    if previous:
        if previous.intent_digest != intent:
            raise VoiceprintError("voiceprint_identity_request_changed", status=409)
        return previous
    if (
        models.SpeakerIdentityJob.objects.filter(
            requester=actor, status__in=["queued", "running"]
        ).count()
        >= 100
    ):
        raise VoiceprintError("voiceprint_identity_budget_exceeded", status=429)
    now = timezone.now()
    expires = now + timezone.timedelta(hours=24)
    if source.expires_at:
        expires = min(expires, source.expires_at)
    return models.SpeakerIdentityJob.objects.create(
        record=locked,
        speaker_id=speaker_id,
        requester=actor,
        organization_id=organization_id,
        request_key=request_key,
        requested_users=[str(identifier) for identifier in identifiers],
        record_revision=expected_revision,
        intent_digest=intent,
        source_digest=source.fingerprint,
        candidate_digest=pool.fingerprint,
        threshold_digest=frozen_policy.digest,
        threshold_version=frozen_policy.threshold_version,
        feature_space=FEATURE_SPACE,
        expires_at=expires,
    )


def stop(job, *, status, code="", retryable=False):
    job.status, job.error_code, job.retryable = status, code, retryable
    job.lease_token, job.lease_until = None, None
    job.finished_at = timezone.now()
    job.save(
        update_fields=[
            "status",
            "error_code",
            "retryable",
            "lease_token",
            "lease_until",
            "finished_at",
            "updated_at",
        ]
    )
    if status in {"canceled", "expired"}:
        suggestions = models.SpeakerIdentitySuggestion.objects.filter(
            job=job, state="pending"
        )
        suggestions.update(
            state="invalidated",
            candidate=None,
            score=None,
            margin=None,
            updated_at=timezone.now(),
        )


def pending_ids(limit):
    if type(limit) is not int or not 1 <= limit <= 100:
        raise VoiceprintError("voiceprint_identity_limit_invalid", status=400)
    now = timezone.now()
    return list(
        models.SpeakerIdentityJob.objects.filter(
            Q(status="queued")
            | Q(status="failed", retryable=True, attempts__lt=MAX_ATTEMPTS)
            | Q(status="running", lease_until__lte=now)
            | Q(status="running", lease_until__isnull=True)
        )
        .order_by("created_at", "pk")
        .values_list("pk", flat=True)[:limit]
    )


def locked_job(identifier):
    initial = models.SpeakerIdentityJob.objects.filter(pk=identifier).first()
    if initial is None:
        return None
    identifiers = candidates.explicit_ids(initial.requested_users)
    lock_scope(initial.requester_id, identifiers, initial.organization_id)
    models.MeetingRecord.objects.select_for_update().filter(
        pk=initial.record_id
    ).first()
    return (
        models.SpeakerIdentityJob.objects.select_for_update()
        .filter(pk=identifier)
        .first()
    )


@transaction.atomic
def claim(identifier):  # noqa: PLR0911 -- State, time and context guards precede all audio I/O.
    if not candidates.enabled():
        return None
    job = locked_job(identifier)
    if job is None:
        return None
    now = timezone.now()
    if not (
        job.status == "queued"
        or job.status == "failed"
        and job.retryable
        and job.attempts < MAX_ATTEMPTS
        or job.status == "running"
        and (job.lease_until is None or job.lease_until <= now)
    ):
        return None
    if job.expires_at <= now:
        stop(job, status="expired", code="identity_expired")
        return None
    if job.attempts >= MAX_ATTEMPTS:
        stop(job, status="failed", code="identity_attempts_exhausted")
        return None
    try:
        source, pool, frozen_policy = context(job)
    except (VoiceprintError, PermissionError) as error:
        if isinstance(error, VoiceprintError) and error.status == 503:
            job.attempts += 1
            job.save(update_fields=["attempts", "updated_at"])
            stop(
                job,
                status="failed",
                code="identity_templates_unavailable",
                retryable=job.attempts < MAX_ATTEMPTS,
            )
        else:
            stop(job, status="canceled", code="identity_context_changed")
        return None
    job.status, job.retryable, job.error_code = "running", False, ""
    job.attempts += 1
    job.lease_token = uuid4()
    job.lease_until = min(
        now + timezone.timedelta(seconds=LEASE_SECONDS), job.expires_at
    )
    job.finished_at = None
    job.save()
    return IdentityLease(
        job.pk,
        job.lease_token,
        job.speaker_id,
        source,
        pool,
        frozen_policy,
        job.lease_until,
    )


def authorized(lease):
    if not isinstance(lease, IdentityLease) or lease.expires_at <= timezone.now():
        return False
    if not models.SpeakerIdentityJob.objects.filter(
        pk=lease.job_id,
        status="running",
        lease_token=lease.token,
        lease_until=lease.expires_at,
        lease_until__gt=timezone.now(),
        expires_at__gt=timezone.now(),
        source_digest=lease.source.fingerprint,
        candidate_digest=lease.pool.fingerprint,
        threshold_digest=lease.policy.digest,
    ).exists():
        return False
    try:
        return (
            policy().digest == lease.policy.digest
            and sources.authorized(lease.source)
            and candidates.authorized(lease.pool)
        )
    except (VoiceprintError, PermissionError):
        return False


@transaction.atomic
def finish(lease, *, query=None, error=None):  # noqa: PLR0911 -- Reject late/context-stale results before a single suggestion write.
    job = locked_job(lease.job_id)
    if job is None or job.status != "running" or job.lease_token != lease.token:
        return False
    now = timezone.now()
    if min(job.expires_at, lease.expires_at) <= now:
        stop(job, status="expired", code="identity_expired")
        return False
    try:
        source, pool, frozen_policy = context(job)
        if (source.fingerprint, pool.fingerprint, frozen_policy.digest) != (
            lease.source.fingerprint,
            lease.pool.fingerprint,
            lease.policy.digest,
        ):
            raise VoiceprintError("voiceprint_identity_context_changed")
    except (VoiceprintError, PermissionError):
        stop(job, status="canceled", code="identity_context_changed")
        return False
    if error is not None:
        stop(
            job,
            status="failed",
            code="identity_provider_unavailable",
            retryable=bool(getattr(error, "retryable", False))
            and job.attempts < MAX_ATTEMPTS,
        )
        return True
    if (
        not isinstance(query, producer.ProducedQuery)
        or query.source_digest != source.fingerprint
        or query.speaker_id != job.speaker_id
    ):
        stop(job, status="failed", code="identity_query_invalid")
        return False
    if query.status == "ready":
        try:
            matching.validate_clips(query.clips)
            spans = intervals.clean_ranges(source.intervals).get(job.speaker_id, ())
            if (
                not query.media_sha256
                or len(query.media_sha256) != 64
                or any(char not in "0123456789abcdef" for char in query.media_sha256)
                or source.receipt.kind == "content_sha256"
                and query.media_sha256 != source.receipt.sha256
                or any(
                    not any(
                        start <= clip.start_ms < clip.end_ms <= end
                        for start, end in spans
                    )
                    for clip in query.clips
                )
            ):
                raise VoiceprintError("voiceprint_identity_query_invalid")
            result = matching.match(query.clips, pool.candidates, policy=frozen_policy)
        except VoiceprintError:
            stop(job, status="failed", code="identity_query_invalid")
            return False
    else:
        refusal = {
            ("unavailable", "source_channels_unsupported"),
            ("insufficient_audio", "clean_intervals_required"),
            ("mixed_speaker", "mixed_speaker"),
            ("mixed_speaker", "query_inconsistent"),
            ("mixed_speaker", "multiple_speakers"),
            ("insufficient_audio", "independent_clips_required"),
            ("insufficient_audio", "speech_required"),
            ("unavailable", "quality_not_verified"),
            ("unavailable", "no_authorized_templates"),
        }
        if (
            query.clips
            or (query.status, query.reason) not in refusal
            or query.reason == "no_authorized_templates"
            and pool.candidates
        ):
            stop(job, status="failed", code="identity_query_invalid")
            return False
        result = matching.MatchResult(query.status, query.reason)
    if not authorized(lease):
        expired = min(job.expires_at, lease.expires_at) <= timezone.now()
        stop(
            job,
            status="expired" if expired else "canceled",
            code="identity_context_changed",
        )
        return False
    models.SpeakerIdentitySuggestion.objects.create(
        job=job,
        candidate_id=result.user_id,
        result=result.status,
        reason=result.reason,
        clip_count=result.clip_count,
        speech_ms=result.valid_speech_ms,
        score=result.score,
        margin=result.margin,
    )
    stop(job, status="succeeded")
    return True


def job_status(identifier):
    return (
        models.SpeakerIdentityJob.objects.filter(pk=identifier)
        .values_list("status", flat=True)
        .first()
        or "skipped"
    )


def process_one(
    identifier, *, media_config, storage_config, encoder_config, quality_config
):
    """Blocking work stays outside the publication transaction and its locks."""
    if not candidates.enabled():
        return "skipped"
    media_config.validate()
    storage_config.validate()
    encoder_config.client()
    quality_config.validate()
    lease = claim(identifier)
    if lease is not None:
        if not lease.pool.candidates:
            finish(
                lease,
                query=producer.ProducedQuery(
                    "unavailable",
                    "no_authorized_templates",
                    lease.source.fingerprint,
                    speaker_id=lease.speaker_id,
                ),
            )
            return job_status(identifier)
        try:
            result = producer.produce(
                lease.source,
                lease.speaker_id,
                policy=lease.policy,
                media_config=media_config,
                storage_config=storage_config,
                encoder_config=encoder_config,
                quality_config=quality_config,
                job_id=lease.job_id,
                expires=int(lease.expires_at.timestamp()),
                authorized=lambda: authorized(lease),
            )
        except Exception as error:  # noqa: BLE001 -- Child cleanup completes; no provider/body/path enters the DB.
            finish(
                lease,
                error=MediaError(
                    "identity_provider_unavailable",
                    retryable=getattr(error, "retryable", False) is True,
                ),
            )
        else:
            finish(lease, query=result)
    return job_status(identifier)


def invalidate_consent_work(consent):
    """Called inside subject revocation; clear every pending association in scope."""
    now = timezone.now()
    jobs = models.SpeakerIdentityJob.objects.filter(
        organization_id=consent.organization_id,
        requested_users__contains=[str(consent.user_id)],
    )
    models.SpeakerIdentitySuggestion.objects.filter(
        job__in=jobs, state="pending"
    ).update(
        state="invalidated", candidate=None, score=None, margin=None, updated_at=now
    )
    jobs.filter(status__in=["queued", "running", "failed", "succeeded"]).update(
        status="canceled",
        error_code="identity_context_changed",
        retryable=False,
        lease_token=None,
        lease_until=None,
        finished_at=now,
        updated_at=now,
    )
