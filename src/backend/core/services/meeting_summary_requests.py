"""User-authorized summary intent, optimistic concurrency and durable dispatch."""

from functools import partial

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from core import models
from core.services.meeting_records import (
    RecordConflict,
    can_generate_summary,
    retry_job,
)
from core.services.meeting_summary_versions import (
    prepare_summary_job,
    requester_is_authorized,
    source_is_current,
)


class SummaryRequestDenied(Exception):
    """Authorization was revoked or does not include generation."""


def requests_enabled():
    """Both data and processing rollouts must be enabled for public mutations."""
    return (
        settings.MEETING_RECORDS_ENABLED
        and settings.MEETING_VERSIONED_SUMMARY_ENABLED
        and settings.MEETING_SUMMARY_REQUESTS_ENABLED
        and settings.CELERY_ENABLED
    )


@transaction.atomic
def request_summary(record_id, user, key, payload):
    """Commit one intent per caller key; replays cannot advance generation/attempt."""
    record = models.MeetingRecord.objects.select_for_update().get(pk=record_id)
    if not requests_enabled() or not can_generate_summary(record, user):
        raise SummaryRequestDenied
    existing = models.MeetingSummaryRequest.objects.filter(user=user, key=key).first()
    if existing:
        if existing.record_id != record.pk or existing.payload != payload:
            raise RecordConflict("Idempotency key was used for another request.")
        transaction.on_commit(
            partial(dispatch_summary_request, existing.pk), robust=True
        )
        return existing, True
    if record.revision != payload["expected_revision"]:
        raise RecordConflict("Record revision changed; refresh before requesting.")
    latest = (
        record.processing_jobs.filter(kind="summary").order_by("-generation").first()
    )
    if (str(latest.pk) if latest else None, latest.attempt if latest else None) != (
        payload["expected_job_id"],
        payload["expected_attempt"],
    ):
        raise RecordConflict("Summary job changed; refresh before requesting.")
    operation = payload["operation"]
    stage = payload.get("stage", "final")
    if operation == "retry":
        if (
            latest is None
            or latest.input_snapshot_id is None
            or latest.configuration.get("stage", "final") != stage
            or not source_is_current(latest)
        ):
            raise RecordConflict(
                "Retry source has changed; generate from current text."
            )
        job = retry_job(latest.pk)
        # An explicit user retry is a new manual attempt, just like regenerate.
        # It must not inherit a disabled/superseded automation consent fence.
        job.configuration = {
            key: value
            for key, value in job.configuration.items()
            if key not in {"automation_id", "automation_revision"}
        }
        job.save(update_fields=["configuration", "updated_at"])
    else:
        # Do not let a second browser supersede an in-flight provider call.
        if (
            latest
            and latest.status in {"queued", "running"}
            and (
                operation == "regenerate"
                or latest.configuration.get("stage", "final") != stage
                or latest.input_revision != record.revision
            )
        ):
            raise RecordConflict("Wait for the current generation to finish.")
        job = prepare_summary_job(
            record.pk, regenerate=operation == "regenerate", stage=stage
        )
    # Pin the initiating user only for a newly requested, not-yet-running job.
    if (
        job.status == "queued"
        and not job.user_requests.filter(attempt=job.attempt).exists()
    ):
        job.configuration = {**job.configuration, "requested_by": str(user.pk)}
        job.save(update_fields=["configuration", "updated_at"])
    request = models.MeetingSummaryRequest.objects.create(
        record=record,
        user=user,
        key=key,
        payload=payload,
        job=job,
        attempt=job.attempt,
        dispatch_state="pending" if job.status == "queued" else "abandoned",
    )
    transaction.on_commit(partial(dispatch_summary_request, request.pk), robust=True)
    return request, False


@transaction.atomic
def dispatch_summary_request(request_id):
    """Retryable outbox dispatch; broker duplicates are fenced by the worker attempt."""
    request = (
        models.MeetingSummaryRequest.objects.select_related("user", "job")
        .filter(pk=request_id)
        .first()
    )
    if request is None or request.dispatch_state != "pending" or not requests_enabled():
        return False
    record = models.MeetingRecord.objects.select_for_update().get(pk=request.record_id)
    request = (
        models.MeetingSummaryRequest.objects.select_for_update()
        .select_related("user", "job")
        .get(pk=request_id)
    )
    if request.dispatch_state != "pending":
        return False
    job = request.job
    authorized = can_generate_summary(record, request.user) and requester_is_authorized(
        job
    )
    if (
        job.status != "queued"
        or job.attempt != request.attempt
        or (
            job.input_revision != record.revision
            and job.configuration.get("stage") not in {"realtime", "quick"}
        )
        or not authorized
    ):
        request.dispatch_state = "abandoned"
        request.error_code = "request_superseded"
        if (
            not authorized
            and job.status == "queued"
            and job.attempt == request.attempt
            and job.configuration.get("requested_by") == str(request.user_id)
        ):
            job.status = "canceled"
            job.error_code = "permission_revoked"
            job.retryable = False
            job.save(update_fields=["status", "error_code", "retryable", "updated_at"])
    else:
        try:
            # send_task always queues; never use the decorator's synchronous fallback in HTTP.
            from meet.celery_app import (  # noqa: PLC0415 -- lazy Celery initialization
                app,
            )

            with app.connection_for_write(connect_timeout=3) as connection:
                connection.transport_options.update(
                    socket_timeout=3, socket_connect_timeout=3
                )
                app.send_task(
                    "core.tasks.summary_versions.generate_record_summary",
                    args=[str(job.pk), request.attempt],
                    connection=connection,
                    retry=False,
                )
            request.dispatch_state = "sent"
            request.error_code = ""
        except Exception:  # noqa: BLE001 -- preserve the durable intent, redact broker details
            request.error_code = "dispatch_unavailable"
    request.dispatch_attempted_at = timezone.now()
    request.save(
        update_fields=[
            "dispatch_state",
            "dispatch_attempted_at",
            "error_code",
            "updated_at",
        ]
    )
    return request.dispatch_state == "sent"


def serialize_summary_job(job):
    """Expose progress without credentials, provider payloads or original text."""
    if job is None:
        return None
    completed, total = (
        job.result.get("chunks_completed"),
        job.result.get("chunks_total"),
    )
    chunk_progress = (
        {"completed": completed, "total": total}
        if type(completed) is int
        and type(total) is int
        and 0 <= completed <= total <= 32
        else None
    )
    return {
        "id": str(job.pk),
        "status": job.status,
        "attempt": job.attempt,
        "generation": job.generation,
        "stage": job.configuration.get("stage", "final"),
        "chunk_progress": chunk_progress,
        "input_revision": job.input_revision,
        "retryable": job.retryable,
        "error_code": job.error_code,
        "updated_at": job.updated_at,
        "dispatch_pending": job.user_requests.filter(
            attempt=job.attempt, dispatch_state="pending"
        ).exists()
        and job.status == "queued",
    }
