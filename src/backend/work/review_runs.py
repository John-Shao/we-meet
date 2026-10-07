"""Explicit per-run opt-in: freeze authorized evidence, never replay execution."""

import hashlib
import json
from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from . import agent_runs, runs
from .models import WorkReview
from .review_contract import validate_report
from .services import MaterialError

VERSION = "pi-review-v1"


def enabled():
    return bool(
        settings.WORK_ENABLED
        and settings.WORK_REVIEW_ENABLED
        and settings.WORK_REVIEW_URL
        and settings.WORK_REVIEW_TOKEN
        and settings.WORK_REVIEW_MODEL
    )


def new_review(run, key, selection):
    """Caller holds owner and source-run locks. Selection pins original file hashes."""
    previous = run.reviews.filter(request_key=key).first()
    if previous:
        if previous.selection != selection:
            raise MaterialError("idempotency_conflict", 409)
        return previous, False
    if not enabled():
        raise MaterialError("review_unavailable", 503)
    if run.status != "succeeded":
        raise MaterialError("review_requires_success", 409)
    if run.reviews.filter(status__in=runs.ACTIVE).exists():
        raise MaterialError("review_active", 409)
    if run.reviews.count() >= 5:
        raise MaterialError("review_limit", 429)
    materials = runs.sources_for(run.task)
    files = {
        f"source-{item.pk}.{'csv' if item.mime == 'text/csv' else 'md'}": item.text
        for item in materials
    }
    manifest = [
        {"file": name, "kind": "material", "name": item.original_name}
        for name, item in zip(files, materials, strict=True)
    ]
    for index, ref in enumerate(selection, 1):
        item = run.files.filter(name=ref["name"], sha256=ref["sha256"]).first()
        if not item:
            raise MaterialError("review_file_unavailable", 409)
        name = f"result-{index:02}.{item.name.rsplit('.', 1)[-1]}"
        files[name] = item.text
        manifest.append(
            {"file": name, "kind": "result", "name": item.name, "sha256": item.sha256}
        )
    files["snapshot.json"] = json.dumps(
        {"source_run_id": str(run.pk), "files": manifest}, ensure_ascii=False
    )
    if sum(len(text.encode()) for text in files.values()) > 400000 or len(files) > 20:
        raise MaterialError("context_too_large", 413)
    budget = min(settings.WORK_REVIEW_TOKEN_BUDGET, 80000)
    output = min(settings.WORK_MAX_OUTPUT_TOKENS, 4096)
    if budget < output + 1024:
        raise MaterialError("review_unavailable", 503)
    if (
        runs.daily_reserved(run.task.owner_id) + budget
        > settings.WORK_DAILY_TOKEN_BUDGET
    ):
        raise MaterialError("budget_exceeded", 429)
    value = WorkReview.objects.create(
        source_run=run,
        request_key=key,
        selection=selection,
        model=settings.WORK_REVIEW_MODEL,
        base_url=settings.WORK_REVIEW_URL,
        reserved_tokens=budget,
        max_output_tokens=output,
        agent_payload={
            "operation": "review",
            "goal": run.task.goal
            + ("\n\n" + run.task.background if run.task.background else ""),
            "files": files,
            "timeout_seconds": min(settings.WORK_AGENT_TIMEOUT, 300),
            "limits": {
                "max_model_calls": 1,
                "max_total_tokens": budget,
                "max_output_tokens": output,
            },
        },
    )
    return value, True


def import_report(review, result):
    try:
        artifacts = result["artifacts"]
        if len(artifacts) != 1 or artifacts[0]["name"] != "pi-review.json":
            raise ValueError
        report = json.loads(artifacts[0]["text"])
        files = [
            {"name": name, "text": text}
            for name, text in review.agent_payload["files"].items()
        ]
        review.report = validate_report(report, files)
    except (ValueError, TypeError, KeyError):
        raise MaterialError("invalid_review_report") from None


def public_data(review):
    return {
        "id": str(review.pk),
        "source_run_id": str(review.source_run_id),
        "status": review.status,
        "error_code": review.error_code,
        "model": review.model,
        "selection": review.selection,
        "reserved_tokens": review.reserved_tokens,
        "input_tokens": review.input_tokens,
        "output_tokens": review.output_tokens,
        "report": review.report,
        "created_at": review.created_at,
        "finished_at": review.finished_at,
        "snapshot": [
            {"name": name, "sha256": hashlib.sha256(text.encode()).hexdigest()}
            for name, text in review.agent_payload["files"].items()
        ],
    }


@transaction.atomic
def claim(exclude):
    now = timezone.now()
    review = (
        WorkReview.objects.select_for_update(skip_locked=True)
        .filter(agent_done=False)
        .exclude(pk__in=exclude)
        .filter(Q(lease_until__isnull=True) | Q(lease_until__lt=now))
        .first()
    )
    if review:
        review.agent_generation += 1
        review.lease_until = now + timedelta(seconds=45)
        review.save(update_fields=["agent_generation", "lease_until"])
    return review


def process_reviews(limit=2):
    seen = []
    for _ in range(limit):
        review = claim(seen)
        if not review:
            break
        seen.append(review.pk)
        agent_runs.reconcile(review)
    return len(seen)
