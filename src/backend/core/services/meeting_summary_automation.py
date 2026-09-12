"""Opt-in, server-driven staged summaries with bounded scheduling and durable intents."""

from datetime import timedelta
from functools import partial
from uuid import uuid5

from django.conf import settings
from django.db import transaction
from django.db.models import F, Q
from django.utils import timezone

from core import models
from core.services.meeting_records import RecordConflict, can_generate_summary
from core.services.meeting_summary_requests import (
    SummaryRequestDenied,
    dispatch_summary_request,
    request_summary,
    requests_enabled,
)
from core.services.meeting_summary_versions import (
    capture_run_id,
    recover_summary_job,
    source_is_current,
    summary_readiness,
)


def automation_enabled():
    """A rollout switch alone never opts any record into billable generation."""
    return (
        requests_enabled()
        and settings.MEETING_STAGED_SUMMARY_ENABLED
        and settings.MEETING_SUMMARY_AUTOMATION_ENABLED
    )


def serialize_automation(automation):
    """No user identities, transcript data or queue/provider configuration."""
    if automation is None:
        return {"revision": 0, "enabled": False, "state": "off", "error_code": ""}
    return {
        "revision": automation.revision,
        "enabled": automation.enabled,
        "state": automation.state,
        "error_code": automation.error_code,
    }


def _cancel_jobs(automation):
    automation.record.processing_jobs.filter(
        kind="summary",
        configuration__automation_id=str(automation.pk),
        status__in=["queued", "running"],
    ).update(
        status="canceled",
        retryable=False,
        error_code="automation_stopped",
        updated_at=timezone.now(),
    )


@transaction.atomic
def control_automation(record_id, user, key, payload):
    """Manager commands are optimistic and idempotent across tabs and reconnects."""
    record = models.MeetingRecord.objects.select_for_update().get(pk=record_id)
    if not can_generate_summary(record, user):
        raise SummaryRequestDenied
    automation = models.MeetingSummaryAutomation.objects.filter(record=record).first()
    previous = models.MeetingSummaryAutomationCommand.objects.filter(
        user=user, key=key
    ).first()
    if previous:
        if previous.record_id != record.pk or previous.payload != payload:
            raise RecordConflict("This automation key belongs to another intent.")
        return previous, automation, True
    if payload["expected_revision"] != (automation.revision if automation else 0):
        raise RecordConflict("Automation has changed; refresh before updating.")
    if payload["enabled"] and not automation_enabled():
        raise RecordConflict("Automatic summary generation is not enabled.")
    if automation is None:
        automation = models.MeetingSummaryAutomation(record=record, requested_by=user)
    else:
        _cancel_jobs(automation)
        automation.revision += 1
    automation.enabled = payload["enabled"]
    automation.requested_by = user
    automation.state = "waiting" if automation.enabled else "off"
    automation.error_code = ""
    automation.checked_at = None
    automation.save()
    command = models.MeetingSummaryAutomationCommand.objects.create(
        record=record,
        user=user,
        key=key,
        payload=payload,
        result=serialize_automation(automation),
    )
    return command, automation, False


def _existing_job_state(automation, latest):
    """Wait, surface a failure, or recognize an up-to-date final without new cost."""
    if latest and latest.status in {"queued", "running"}:
        if latest.status == "queued" and latest.configuration.get(
            "automation_id"
        ) == str(automation.pk):
            # A broker acknowledgement is not a worker acknowledgement. Re-send
            # the same attempt after 30 seconds; the worker claims it only once.
            intent = (
                latest.user_requests.filter(
                    attempt=latest.attempt,
                    dispatch_state="sent",
                    dispatch_attempted_at__lt=timezone.now() - timedelta(seconds=30),
                )
                .order_by("created_at")
                .first()
            )
            if intent:
                intent.dispatch_state = "pending"
                intent.save(update_fields=["dispatch_state", "updated_at"])
                transaction.on_commit(
                    partial(dispatch_summary_request, intent.pk), robust=True
                )
        if latest.status == "running" and latest.configuration.get(
            "automation_id"
        ) == str(automation.pk):
            try:
                recover_summary_job(latest.pk)
            except RecordConflict:
                pass
            latest.refresh_from_db()
        if latest.status == "failed":
            automation.state = "needs_attention"
            automation.error_code = latest.error_code
        else:
            automation.state = "generating"
        automation.save()
        return True
    if latest and latest.status == "failed":
        # Never repeatedly charge for an unavailable model or invalid output.
        automation.state = "needs_attention"
        automation.error_code = latest.error_code
        automation.save()
        return True
    if (
        latest
        and latest.status in {"partial", "succeeded"}
        and latest.configuration.get("stage", "final") == "final"
        and source_is_current(latest)
    ):
        automation.state = "completed"
        automation.save()
        return True
    return False


def _has_quick_for_capture(record):
    """Each explicitly started recording window may produce its own quick version."""
    run_id = capture_run_id(record)
    scope = {"job__configuration__capture_run_id": run_id} if run_id else {}
    return record.summary_versions.filter(stage="quick", **scope).exists()


@transaction.atomic
def tick_automation(automation_id):  # noqa: PLR0911 -- explicit lifecycle outcomes
    """At most one new durable summary request per locked record and tick."""
    if not automation_enabled():
        return False
    automation = models.MeetingSummaryAutomation.objects.filter(
        pk=automation_id
    ).first()
    if automation is None:
        return False
    record = models.MeetingRecord.objects.select_for_update().get(
        pk=automation.record_id
    )
    automation = models.MeetingSummaryAutomation.objects.select_related(
        "requested_by"
    ).get(pk=automation_id)
    if not automation.enabled:
        return False
    automation.checked_at = timezone.now()
    if not automation.requested_by or not can_generate_summary(
        record, automation.requested_by
    ):
        _cancel_jobs(automation)
        automation.enabled = False
        automation.revision += 1
        automation.state = "needs_attention"
        automation.error_code = "permission_revoked"
        automation.save()
        return False
    latest = (
        record.processing_jobs.filter(kind="summary").order_by("-generation").first()
    )
    automation.error_code = ""
    if _existing_job_state(automation, latest):
        return False
    readiness = summary_readiness(record)
    if readiness.get("blocked_reason"):
        automation.state = "needs_attention"
        automation.error_code = readiness["blocked_reason"]
        automation.save()
        return False
    stages = readiness["ready_stages"]
    if "realtime" in stages:
        stage = "realtime"
    elif "quick" in stages and not _has_quick_for_capture(record):
        stage = "quick"
    elif "final" in stages:
        stage = "final"
    else:
        automation.state = "waiting"
        automation.save()
        return False
    # A generation plus source revision identifies this tick's durable intent.
    # Replay never adopts newly changed expected job state under an existing key.
    key = uuid5(
        automation.pk,
        f"{automation.revision}:{stage}:{record.revision}:{latest.pk if latest else 'initial'}:{latest.attempt if latest else 0}",
    )
    payload = {
        "stage": stage,
        "operation": "generate",
        "expected_revision": record.revision,
        "expected_job_id": str(latest.pk) if latest else None,
        "expected_attempt": latest.attempt if latest else None,
    }
    try:
        intent, _ = request_summary(record.pk, automation.requested_by, key, payload)
    except RecordConflict:
        automation.state = "waiting"
        automation.save()
        return False
    job = intent.job
    if job.status == "queued":
        job.configuration = {
            **job.configuration,
            "automation_id": str(automation.pk),
            "automation_revision": automation.revision,
        }
        job.save(update_fields=["configuration", "updated_at"])
    automation.state = "generating" if job.status == "queued" else "waiting"
    automation.save()
    return job.status == "queued"


def tick_automations(*, limit=100):
    """Fair bounded scan plus outbox recovery; neither runs the model inline."""
    if not automation_enabled():
        return 0
    ids = list(
        models.MeetingSummaryAutomation.objects.filter(enabled=True)
        .order_by(F("checked_at").asc(nulls_first=True), "id")
        .values_list("pk", flat=True)[:limit]
    )
    started = sum(tick_automation(pk) for pk in ids)
    for pk in (
        models.MeetingSummaryRequest.objects.filter(dispatch_state="pending")
        .filter(
            Q(dispatch_attempted_at__isnull=True)
            | Q(dispatch_attempted_at__lt=timezone.now() - timedelta(seconds=30))
        )
        .order_by(F("dispatch_attempted_at").asc(nulls_first=True), "id")
        .values_list("pk", flat=True)[:limit]
    ):
        dispatch_summary_request(pk)
    return started
