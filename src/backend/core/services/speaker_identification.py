"""Private record batches and human decisions; provider work remains asynchronous."""

from uuid import UUID

from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from core import models
from core.services import speaker_contacts
from core.services import speaker_identity_jobs as jobs
from core.services import voiceprint_candidates as candidates
from core.services import voiceprint_consent as consent
from core.services import voiceprint_sources as sources
from core.services.effective_transcripts import current_generation
from core.services.meeting_records import (
    RecordConflict,
    bump_record_source,
    visible_records,
)
from core.services.voiceprint_consent import VoiceprintError


def record_access(identifier, actor, *, expected_revision=None):
    actor = consent.owner(actor)
    record = (
        visible_records(actor, ability="read_transcript")
        .filter(
            pk=identifier,
            can_manage_record=True,
            collaboration_media=True,
        )
        .first()
    )
    if record is None:
        raise VoiceprintError("voiceprint_media_access_unavailable", status=404)
    if expected_revision is not None:
        if type(expected_revision) is not int or expected_revision < 1:
            raise VoiceprintError("voiceprint_revision_invalid", status=400)
        if record.revision != expected_revision:
            raise RecordConflict("identity_revision_changed")
    return record, actor


def visible_requests(record, actor):
    organizations = models.Membership.objects.filter(
        user=actor,
        status=models.MembershipStatusChoices.ACTIVE,
        organization__is_active=True,
    ).values("organization_id")
    return models.SpeakerIdentityRequest.objects.filter(record=record).filter(
        Q(organization__isnull=True, requester=actor)
        | Q(organization_id__in=organizations)
    )


def request_jobs(batch):
    result = list(batch.jobs.select_for_update().order_by("pk")[:51])
    targets = candidates.explicit_ids(batch.target_ids)
    if (
        len(result) != len(targets)
        or {job.speaker_id for job in result} != set(targets)
        or any(
            job.record_id != batch.record_id
            or job.requester_id != batch.requester_id
            or job.organization_id != batch.organization_id
            or job.request_key != batch.request_key
            or job.requested_users != batch.requested_users
            for job in result
        )
    ):
        raise VoiceprintError("voiceprint_identity_request_changed", status=409)
    return result


def locked_request(record_id, actor, request_key, *, expected_revision=None):
    record, actor = record_access(record_id, actor)
    queryset = visible_requests(record, actor)
    if request_key is not None:
        queryset = queryset.filter(request_key=request_key)
    initial = queryset.order_by("-created_at", "-pk").first()
    if initial is None:
        if request_key is not None:
            raise VoiceprintError("voiceprint_identity_request_unavailable", status=404)
        return record, actor, None
    identifiers = candidates.explicit_ids(initial.requested_users)
    jobs.lock_scope(
        initial.requester_id,
        identifiers,
        initial.organization_id,
        extra_actors=(actor.pk,),
    )
    if (
        models.MeetingRecord.objects.select_for_update().filter(pk=record_id).first()
        is None
    ):
        raise VoiceprintError("voiceprint_media_access_unavailable", status=404)
    record, actor = record_access(record_id, actor, expected_revision=expected_revision)
    batch = (
        visible_requests(record, actor)
        .select_for_update()
        .filter(pk=initial.pk)
        .first()
    )
    if batch is None:
        raise VoiceprintError("voiceprint_identity_request_unavailable", status=404)
    return record, actor, batch


def unnamed(speaker):
    return (
        speaker.user_id is None
        and not speaker.manual_label
        and speaker.attribution_kind == "none"
    )


@transaction.atomic
def submit(  # noqa: PLR0913 -- Explicit bounded request scope.
    record_id,
    actor,
    *,
    organization_id,
    user_ids,
    expected_revision,
    request_key,
    speaker_ids=None,
):
    if not isinstance(request_key, UUID):
        raise VoiceprintError("voiceprint_identity_request_invalid", status=400)
    identifiers = candidates.explicit_ids(user_ids)
    organization_id = candidates.explicit_scope(organization_id)
    selected = candidates.explicit_ids(speaker_ids) if speaker_ids is not None else None
    jobs.lock_scope(actor.pk, identifiers, organization_id)
    models.MeetingRecord.objects.select_for_update().filter(pk=record_id).first()
    record, actor = record_access(record_id, actor, expected_revision=expected_revision)
    if not candidates.enabled():
        raise VoiceprintError("voiceprint_matching_disabled", status=503)
    policy = jobs.policy()
    if len(identifiers) > policy.max_candidates:
        raise VoiceprintError("voiceprint_candidates_invalid", status=400)
    source = sources.snapshot(record, actor, expected_revision=expected_revision)
    pool = candidates.load_pool(
        record,
        actor,
        organization_id=organization_id,
        user_ids=identifiers,
        expected_revision=expected_revision,
    )
    input_digest = sources.digest(
        {
            "actor": str(actor.pk),
            "organization": str(organization_id),
            "users": [str(value) for value in identifiers],
            "speakers": [str(value) for value in selected] if selected else None,
            "source": source.fingerprint,
            "candidates": pool.fingerprint,
            "threshold": policy.digest,
        }
    )
    batch = models.SpeakerIdentityRequest.objects.filter(
        record=record, request_key=request_key
    ).first()
    if batch:
        if batch.input_digest != input_digest:
            raise VoiceprintError("voiceprint_identity_request_changed", status=409)
        for job in request_jobs(batch):
            jobs.validate_context(job, source, pool, policy)
            jobs.validate_presentation(job)
        return payload(record, batch, request_jobs(batch))
    known = {row.speaker_id for row in source.intervals} - {None}
    if selected is not None and not set(selected) <= known:
        raise VoiceprintError("voiceprint_source_speaker_unavailable", status=404)
    speakers = list(
        models.MeetingSpeaker.objects.select_for_update()
        .filter(
            record=record,
            pk__in=selected if selected is not None else known,
        )
        .order_by("pk")
    )
    if selected is not None and any(not unnamed(speaker) for speaker in speakers):
        raise VoiceprintError("voiceprint_identity_manual_choice_exists", status=409)
    speakers = [speaker for speaker in speakers if unnamed(speaker)]
    if not speakers:
        raise VoiceprintError("voiceprint_identity_targets_required", status=400)
    batch = models.SpeakerIdentityRequest.objects.create(
        record=record,
        requester=actor,
        organization_id=organization_id,
        request_key=request_key,
        input_digest=input_digest,
        requested_users=[str(value) for value in identifiers],
        target_ids=[str(speaker.pk) for speaker in speakers],
        record_revision=record.revision,
    )
    result = [
        jobs.enqueue_prepared(
            record, actor, speaker, source, pool, policy, request_key, batch=batch
        )
        for speaker in speakers
    ]
    if any(job.batch_id != batch.pk for job in result):
        raise VoiceprintError("voiceprint_identity_request_changed", status=409)
    return payload(record, batch, result)


def processing(result):
    return any(
        job.expires_at > timezone.now()
        and (
            job.status in {"queued", "running"}
            or job.status == "failed"
            and job.retryable
            and job.attempts < jobs.MAX_ATTEMPTS
        )
        for job in result
    )


def payload(record, batch, result, *, valid=(), unavailable=False):
    suggestions = {
        row.job_id: row
        for row in models.SpeakerIdentitySuggestion.objects.filter(
            job__in=result,
        ).select_related("candidate")
    }
    rows = []
    busy = processing(result)
    for job in result:
        suggestion = suggestions.get(job.pk)
        verified = job.pk in valid and suggestion and suggestion.state == "pending"
        row = {
            "id": str(job.pk),
            "speaker_id": str(job.speaker_id),
            "status": job.status,
            "retryable": job.retryable,
            "suggestion": None,
        }
        if suggestion:
            row["suggestion"] = {
                "id": str(suggestion.pk),
                "state": suggestion.state,
                "result": suggestion.result,
                "reason": suggestion.reason,
                "clip_count": suggestion.clip_count,
                "speech_ms": suggestion.speech_ms,
                "query_intervals": suggestion.query_intervals if verified else [],
                "can_confirm": bool(
                    verified
                    and not busy
                    and suggestion.result == "suggested"
                    and suggestion.candidate_id
                ),
                "verification_unavailable": unavailable,
                "candidate": {
                    "id": str(suggestion.candidate_id),
                    "name": speaker_contacts.name(suggestion.candidate),
                }
                if verified
                and suggestion.result == "suggested"
                and suggestion.candidate_id
                else None,
            }
        rows.append(row)
    return {
        "record_revision": record.revision,
        "request": {
            "id": str(batch.pk),
            "request_key": str(batch.request_key),
            "organization_id": str(batch.organization_id)
            if batch.organization_id
            else None,
            "source_revision": batch.record_revision,
            "created_at": batch.created_at.isoformat(),
            "jobs": rows,
            "processing": busy,
        }
        if batch
        else None,
    }


def refresh_pending(record, actor, result):
    pending = {
        row.job_id
        for row in models.SpeakerIdentitySuggestion.objects.filter(
            job__in=result, state="pending"
        )
    }
    for job in result:
        if job.expires_at <= timezone.now() and (
            job.pk in pending or job.status in {"queued", "running", "failed"}
        ):
            jobs.stop(job, status="expired", code="identity_expired")
    live = [job for job in result if job.pk in pending and job.status != "expired"]
    if not live:
        return (), False
    try:
        first = live[0]
        candidates.scope(
            record.pk,
            actor.pk,
            first.organization_id,
            candidates.explicit_ids(first.requested_users),
            record.revision,
        )
        source, pool, policy = jobs.load_context(
            first, current_revision=record.revision
        )
    except (VoiceprintError, PermissionError) as error:
        if isinstance(error, VoiceprintError) and error.status == 503:
            return (), True
        for job in live:
            jobs.stop(job, status="canceled", code="identity_context_changed")
        return (), False
    valid = []
    for job in live:
        try:
            jobs.validate_context(
                job, source, pool, policy, current_revision=record.revision
            )
            jobs.validate_presentation(job)
            if job.status != "succeeded":
                raise VoiceprintError("voiceprint_identity_context_changed", status=409)
        except VoiceprintError:
            jobs.stop(
                job,
                status="expired" if job.expires_at <= timezone.now() else "canceled",
                code="identity_context_changed",
            )
        else:
            valid.append(job.pk)
    return valid, False


@transaction.atomic
def read(record_id, actor, *, request_key=None):
    record, actor, batch = locked_request(record_id, actor, request_key)
    if not candidates.enabled():
        raise VoiceprintError("voiceprint_matching_disabled", status=503)
    if batch is None:
        return payload(record, None, [])
    result = request_jobs(batch)
    valid, unavailable = refresh_pending(record, actor, result)
    return payload(record, batch, result, valid=valid, unavailable=unavailable)


@transaction.atomic
def cancel(record_id, actor, *, request_key, expected_revision):
    if (
        not isinstance(request_key, UUID)
        or type(expected_revision) is not int
        or expected_revision < 1
    ):
        raise VoiceprintError("voiceprint_identity_request_invalid", status=400)
    record, actor, batch = locked_request(
        record_id, actor, request_key, expected_revision=expected_revision
    )
    result = request_jobs(batch)
    for job in result:
        if (
            job.status in {"queued", "running", "failed"}
            or models.SpeakerIdentitySuggestion.objects.filter(
                job=job, state="pending"
            ).exists()
        ):
            jobs.stop(job, status="canceled", code="identity_user_canceled")
    return payload(record, batch, result)


def decision_locks(record_id, speaker_id, actor, suggestion_id, expected_revision):
    record_access(record_id, actor)
    initial = (
        models.SpeakerIdentitySuggestion.objects.filter(
            pk=suggestion_id,
            job__record_id=record_id,
            job__speaker_id=speaker_id,
            job__batch__isnull=False,
        )
        .select_related("job")
        .first()
    )
    if initial is None:
        raise VoiceprintError("voiceprint_suggestion_unavailable", status=404)
    job = initial.job
    jobs.lock_scope(
        job.requester_id,
        candidates.explicit_ids(job.requested_users),
        job.organization_id,
        extra_actors=(actor.pk,),
    )
    if (
        models.MeetingRecord.objects.select_for_update().filter(pk=record_id).first()
        is None
    ):
        raise VoiceprintError("voiceprint_media_access_unavailable", status=404)
    record, actor = record_access(record_id, actor, expected_revision=expected_revision)
    if not visible_requests(record, actor).filter(pk=job.batch_id).exists():
        raise VoiceprintError("voiceprint_suggestion_unavailable", status=404)
    job = (
        models.SpeakerIdentityJob.objects.select_for_update().filter(pk=job.pk).first()
    )
    suggestion = (
        models.SpeakerIdentitySuggestion.objects.select_for_update()
        .filter(pk=suggestion_id)
        .first()
    )
    if job is None or suggestion is None:
        raise VoiceprintError("voiceprint_suggestion_unavailable", status=404)
    speaker = (
        models.MeetingSpeaker.objects.select_for_update()
        .filter(
            pk=speaker_id,
            record=record,
            pk__in=current_generation(record.original_segments.all()).values(
                "speaker_id"
            ),
        )
        .first()
    )
    if speaker is None:
        raise VoiceprintError("voiceprint_source_speaker_unavailable", status=404)
    speaker.record = record
    return record, actor, job, suggestion, speaker


def confirm_context(record, actor, job, suggestion, speaker):
    if not candidates.enabled():
        raise VoiceprintError("voiceprint_matching_disabled", status=503)
    candidates.scope(
        record.pk,
        actor.pk,
        job.organization_id,
        candidates.explicit_ids(job.requested_users),
        record.revision,
    )
    _, pool, _ = jobs.context(job, current_revision=record.revision)
    if (
        job.status != "succeeded"
        or suggestion.result != "suggested"
        or suggestion.candidate_id
        not in {candidate.user_id for candidate in pool.candidates}
        or not unnamed(speaker)
        or speaker.identity_type != "diarized"
    ):
        raise VoiceprintError("voiceprint_suggestion_changed", status=409)


def apply_decision(record, actor, job, suggestion, speaker, action):  # noqa: PLR0913 -- One atomic human decision and audit.
    before = speaker.user_id, speaker.manual_label, speaker.attribution_kind
    now = timezone.now()
    if action == "confirm_suggestion":
        speaker.user_id = suggestion.candidate_id
        speaker.manual_label, speaker.attribution_kind, speaker.contact_source = (
            "",
            "member",
            None,
        )
        speaker.attributed_by, speaker.attributed_at = actor, now
        speaker.save(
            update_fields=[
                "user",
                "manual_label",
                "attribution_kind",
                "contact_source",
                "attributed_by",
                "attributed_at",
                "updated_at",
            ]
        )
        suggestion.state = "confirmed"
    else:
        suggestion.state, suggestion.candidate, suggestion.score, suggestion.margin = (
            "rejected",
            None,
            None,
            None,
        )
    suggestion.decided_by, suggestion.decided_at = actor, now
    suggestion.save()
    bump_record_source(record)
    models.SpeakerIdentityDecision.objects.create(
        record=record,
        speaker=speaker,
        actor=actor,
        suggestion=suggestion,
        action=action,
        previous_user_id=before[0],
        previous_label=before[1],
        previous_kind=before[2],
        selected_user_id=speaker.user_id,
        selected_label=speaker.manual_label,
        selected_kind=speaker.attribution_kind,
        record_revision=record.revision,
    )
    jobs.invalidate_target(record.pk, speaker.pk, exclude_job_id=job.pk)
    speaker.record = record
    return speaker


def decide(record_id, speaker_id, actor, *, action, suggestion_id, expected_revision):  # noqa: PLR0913 -- Explicit suggestion version and target.
    if (
        action not in {"confirm_suggestion", "reject_suggestion"}
        or not isinstance(suggestion_id, UUID)
        or type(expected_revision) is not int
        or expected_revision < 1
    ):
        raise VoiceprintError("voiceprint_identity_request_invalid", status=400)
    outcome = None
    with transaction.atomic():
        record, actor, job, suggestion, speaker = decision_locks(
            record_id,
            speaker_id,
            actor,
            suggestion_id,
            expected_revision,
        )
        expected_state = "confirmed" if action == "confirm_suggestion" else "rejected"
        if suggestion.state == expected_state:
            if (
                expected_state == "confirmed"
                and speaker.user_id != suggestion.candidate_id
            ):
                raise VoiceprintError("voiceprint_suggestion_changed", status=409)
            return speaker
        if suggestion.state != "pending":
            raise VoiceprintError("voiceprint_suggestion_changed", status=409)
        if processing(request_jobs(job.batch)):
            raise VoiceprintError("voiceprint_identity_request_processing", status=409)
        if action == "confirm_suggestion":
            try:
                confirm_context(record, actor, job, suggestion, speaker)
            except (VoiceprintError, PermissionError) as error:
                if isinstance(error, VoiceprintError) and error.status == 503:
                    outcome = error
                else:
                    jobs.stop(
                        job,
                        status="expired"
                        if job.expires_at <= timezone.now()
                        else "canceled",
                        code="identity_context_changed",
                    )
                    outcome = VoiceprintError(
                        "voiceprint_suggestion_changed", status=409
                    )
        if outcome is None:
            return apply_decision(record, actor, job, suggestion, speaker, action)
    # Invalidation commits before an error is returned; no outer decision atomic block.
    raise outcome
