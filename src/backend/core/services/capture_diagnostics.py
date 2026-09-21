"""Bounded, content-free ASR failure history independent of Pod log retention."""

from datetime import timedelta

from django.utils import timezone

from core import models

MAX_EVENTS = 20
RETENTION_DAYS = 30
STAGES = frozenset(
    {
        "manifest",
        "control",
        "storage_read",
        "audio_validate",
        "storage_prepare",
        "storage_upload",
        "storage_sign",
        "transcription_submit",
        "transcription_poll",
        "result_fetch",
        "result_parse",
        "delivery",
        "cleanup",
        "finish",
        "execution",
    }
)
CODES = frozenset({"failed", "timeout", "no_speech"})


def expired(job):
    """Retention is fixed at creation and cannot be extended by repeated reports."""
    return job.created_at + timedelta(days=RETENTION_DAYS) <= timezone.now()


def visible(job):
    """Project allowlisted keys even if stored data is malformed or from a future worker."""
    if expired(job) or not isinstance(job.diagnostics, list):
        return []
    result = []
    seen = set()
    for event in job.diagnostics[:MAX_EVENTS]:
        if (
            not isinstance(event, dict)
            or not isinstance(event.get("stage"), str)
            or event.get("stage") not in STAGES
            or not isinstance(event.get("code"), str)
            or event.get("code") not in CODES
            or type(event.get("elapsed_ms")) is not int
            or not 0 <= event["elapsed_ms"] <= 172800000
        ):
            continue
        key = (event["stage"], event["code"])
        if key not in seen:
            result.append({k: event[k] for k in ("stage", "code", "elapsed_ms")})
            seen.add(key)
    return result


def prune(limit=100):
    """The existing ASR tick removes expired histories in bounded batches."""
    ids = list(
        models.CaptureTranscriptionJob.objects.filter(
            created_at__lte=timezone.now() - timedelta(days=RETENTION_DAYS),
        )
        .exclude(diagnostics=[])
        .order_by("created_at", "id")
        .values_list("pk", flat=True)[:limit]
    )
    return models.CaptureTranscriptionJob.objects.filter(pk__in=ids).update(
        diagnostics=[]
    )
