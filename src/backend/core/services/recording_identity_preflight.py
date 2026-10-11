"""Explicit import identity intent, pre-paid gates and recoverable user choice."""

import json
import time
from datetime import timedelta
from pathlib import Path
from uuid import UUID

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from core import models
from core.services import recording_import_inputs as inputs
from core.services import speaker_identity_jobs as identity_jobs
from core.services import voiceprint_candidates as candidates
from core.services import voiceprint_consent as consent
from core.services import voiceprint_import_media as preparation
from core.services import voiceprint_media as media
from core.services import voiceprint_source_storage as storage_service
from core.services.capture_storage import audio_storage
from core.services.meeting_records import RecordConflict, visible_records
from core.services.voiceprint_consent import VoiceprintError
from core.services.voiceprint_media_process import MediaError
from core.services.voiceprint_source_objects import parse
from core.services.voiceprint_sources import digest


def requested(job):
    return (
        job.configuration.get("identity") is not None
        and job.configuration.get("_identity_disabled") is not True
    )


def media_config():
    try:
        path = Path(settings.MEETING_VOICEPRINT_MEDIA_CONFIG_FILE)
        if not path.is_absolute():
            raise ValueError
        with path.open("rb") as stream:
            payload = stream.read(8193)
        if not 0 < len(payload) <= 8192:
            raise ValueError
        value = json.loads(payload)
        if not isinstance(value, dict) or set(value) != {"ffmpeg", "ffprobe"}:
            raise ValueError
        return media.MediaConfiguration(**value).validate()
    except (ValueError, TypeError, OSError, RecursionError):
        raise VoiceprintError(
            "voiceprint_media_configuration_unavailable", status=503
        ) from None


def expected_owner(user, header, intent):
    if intent is not None and header != str(user.pk):
        raise VoiceprintError("voiceprint_account_changed", status=401)


def normalize(user, options, *, admit=True):
    options = dict(options)
    intent = options.pop("identity", None)
    if intent is None:
        return options
    if not isinstance(intent, dict) or set(intent) != {
        "organization_id",
        "candidate_user_ids",
    }:
        raise VoiceprintError("voiceprint_import_intent_invalid", status=400)
    if options.get("diarization") is not True:
        raise VoiceprintError("voiceprint_diarization_required", status=400)
    if admit and not candidates.enabled():
        raise VoiceprintError("voiceprint_matching_disabled", status=503)
    actor = consent.owner(user)
    organization_id = candidates.explicit_scope(intent["organization_id"])
    identifiers = candidates.explicit_ids(intent["candidate_user_ids"])
    if not admit:
        pass  # Adopting already declared bytes does not grant matching access.
    elif organization_id is None:
        if identifiers != (actor.pk,):
            raise VoiceprintError("voiceprint_candidate_scope_unavailable")
    else:
        organization = consent.scope(actor, organization_id)
        members = set(
            models.Membership.objects.filter(
                organization=organization,
                user_id__in=identifiers,
                user__is_active=True,
                user__is_device=False,
                status=models.MembershipStatusChoices.ACTIVE,
            ).values_list("user_id", flat=True)
        )
        if not consent.available(actor, organization) or members != set(identifiers):
            raise VoiceprintError("voiceprint_candidate_scope_unavailable")
    if admit:
        if len(identifiers) > identity_jobs.policy().max_candidates:
            raise VoiceprintError("voiceprint_candidates_invalid", status=400)
        media_config()
    return {
        **options,
        "identity": {
            "organization_id": str(organization_id) if organization_id else None,
            "candidate_user_ids": [str(identifier) for identifier in identifiers],
        },
    }


def context(job):
    intent = normalize(
        job.record.owner,
        {
            "diarization": job.configuration.get("diarization"),
            "identity": job.configuration.get("identity"),
        },
    )["identity"]
    policy = identity_jobs.policy()
    pool = candidates.load_pool(
        job.record,
        job.record.owner,
        organization_id=intent["organization_id"],
        user_ids=intent["candidate_user_ids"],
        expected_revision=job.record.revision,
    )
    if not pool.candidates:
        raise VoiceprintError("voiceprint_candidate_pool_unavailable")
    return pool, policy


def parent_source(job):
    try:
        receipt = parse(job.configuration.get("_identity_source"))
        if (
            receipt.key != job.storage_name
            or receipt.size != job.size
            or receipt.size > media.MAX_SOURCE_BYTES
            or receipt.kind == "s3_object"
            and receipt.version_id is None
            or receipt.kind == "content_sha256"
            and receipt.sha256 != job.checksum
        ):
            raise ValueError
        return receipt
    except (ValueError, TypeError):
        raise VoiceprintError("voiceprint_source_integrity_unavailable") from None


def run(job):
    pool, policy = context(job)
    parent = parent_source(job)
    expires = min(int(job.deadline.timestamp()), int(time.time()) + 540)

    def live():
        current = (
            models.UploadedRecording.objects.filter(
                pk=job.pk,
                lease_id=job.lease_id,
                lease_until__gt=timezone.now(),
                status="queued",
                identity_state="preflighting",
                record__deleted_at__isnull=True,
                record__owner__is_active=True,
                record__revision=job.record.revision,
            )
            .values_list("configuration", flat=True)
            .first()
        )
        return bool(
            current
            and current.get("_identity_source") == parent.payload()
            and current.get("identity") == job.configuration["identity"]
            and candidates.authorized(pool)
            and identity_jobs.policy().digest == policy.digest
        )

    config = storage_service.from_storage(audio_storage())
    with storage_service.download(
        parent, config=config, expires=expires, authorized=live
    ) as downloaded:
        with preparation.prepare(
            downloaded.media, config=media_config(), expires=expires, authorized=live
        ) as prepared:
            artifact = None
            if prepared.derived:
                artifact = inputs.reserve(job, parent)
                artifact = inputs.upload(
                    artifact, prepared, config=config, expires=expires, authorized=live
                )
            if not live():
                raise VoiceprintError("voiceprint_matching_context_changed", status=409)
            return {
                "schema": 1,
                "input_id": str(artifact.pk) if artifact else None,
                "duration_ms": prepared.info.duration_ms,
                "original_duration_ms": prepared.original_duration_ms,
                "time_offset_ms": 0,
                "channels": 1,
                "source_digest": digest(parent.payload()),
                "candidate_digest": pool.fingerprint,
                "threshold_digest": policy.digest,
            }


def verify(job):
    current = (
        models.UploadedRecording.objects.filter(
            pk=job.pk,
            attempt=job.attempt,
            lease_id=job.lease_id,
            lease_until__gt=timezone.now(),
            deadline__gt=timezone.now(),
            status="submitting",
            identity_state="ready",
            record__deleted_at__isnull=True,
            record__owner_id=job.record.owner_id,
            record__revision=job.record.revision,
        )
        .values_list("configuration", flat=True)
        .first()
    )
    if current != job.configuration:
        raise VoiceprintError("voiceprint_matching_context_changed", status=409)
    pool, policy = context(job)
    parent = parent_source(job)
    proof = job.configuration.get("_preflight")
    if (
        not isinstance(proof, dict)
        or set(proof)
        != {
            "schema",
            "input_id",
            "duration_ms",
            "original_duration_ms",
            "time_offset_ms",
            "channels",
            "source_digest",
            "candidate_digest",
            "threshold_digest",
        }
        or type(proof.get("schema")) is not int
        or proof.get("schema") != 1
        or type(proof.get("channels")) is not int
        or proof.get("channels") != 1
        or type(proof.get("duration_ms")) is not int
        or not 0 < proof.get("duration_ms", 0) <= media.MAX_DURATION_MS
        or type(proof.get("original_duration_ms")) is not int
        or abs(proof.get("original_duration_ms", 0) - proof.get("duration_ms", 0)) > 1
        or type(proof.get("time_offset_ms")) is not int
        or proof.get("time_offset_ms") != 0
        or proof.get("source_digest") != digest(parent.payload())
        or proof.get("candidate_digest") != pool.fingerprint
        or proof.get("threshold_digest") != policy.digest
        or not candidates.authorized(pool)
    ):
        raise VoiceprintError("voiceprint_matching_context_changed", status=409)
    inputs.selected(job)


def failure(job, error):
    reasons = {
        "voiceprint_candidate_pool_unavailable",
        "voiceprint_candidate_scope_unavailable",
        "voiceprint_source_integrity_unavailable",
        "voiceprint_calibration_required",
        "voiceprint_matching_disabled",
        "voiceprint_templates_unavailable",
        "voiceprint_matching_context_changed",
        "media_time_mapping_unavailable",
        "media_audio_stream_unsupported",
        "media_probe_invalid",
        "media_authorization_revoked",
        "media_deadline_exceeded",
        "media_source_integrity_unavailable",
        "media_storage_unavailable",
    }
    code = str(error) if str(error) in reasons else "identity_preflight_unavailable"
    changed = models.UploadedRecording.objects.filter(
        pk=job.pk, lease_id=job.lease_id
    ).update(
        status="failed",
        error_code="identity_preflight_failed",
        identity_state="awaiting_choice",
        identity_error=code,
        lease_id=None,
        lease_until=None,
        updated_at=timezone.now(),
    )
    if changed:
        inputs.abandon(job)


@transaction.atomic
def decide(record_id, user, *, attempt, action):
    if (
        type(attempt) is not int
        or attempt < 1
        or action not in {"retry_identity", "continue_without_identity"}
    ):
        raise VoiceprintError("voiceprint_import_decision_invalid", status=400)
    consent.owner(user, lock=True)
    record = models.MeetingRecord.objects.select_for_update().get(pk=record_id)
    job = models.UploadedRecording.objects.select_for_update().get(record=record)
    if (
        record.owner_id != user.pk
        or not visible_records(user, ability="read_transcript")
        .filter(pk=record_id)
        .exists()
    ):
        raise VoiceprintError("voiceprint_record_unavailable", status=404)
    previous = job.configuration.get("_identity_decision")
    if (
        previous == {"attempt": attempt, "action": action}
        and job.attempt == attempt + 1
    ):
        return job
    if (
        job.attempt != attempt
        or job.status != "failed"
        or job.identity_state != "awaiting_choice"
    ):
        raise RecordConflict("Import decision changed.")
    from core.services import (  # noqa: PLC0415 -- Upload admission also calls this module.
        uploaded_recordings as uploads,
    )

    if not uploads.available() or uploads.active_upload_exists(user):
        raise RecordConflict("Transcription is unavailable for this requester.")
    job.configuration.pop("_preflight", None)
    job.configuration["_identity_decision"] = {"attempt": attempt, "action": action}
    if action == "continue_without_identity":
        job.configuration.update(_identity_disabled=True, _diarization_disabled=True)
        job.identity_state = "disabled"
    else:
        normalize(user, job.configuration)
        job.identity_state = "pending"
    job.attempt += 1
    job.status, job.error_code, job.identity_error = "queued", "", ""
    job.deadline = timezone.now() + timedelta(hours=24)
    job.next_poll_at = timezone.now()
    job.save()
    return job
