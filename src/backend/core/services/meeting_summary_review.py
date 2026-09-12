"""Explicit human summary revisions, independent of the immutable AI generation lane."""

import hashlib
import json

from django.conf import settings
from django.db import transaction

from pydantic import BaseModel, ConfigDict, Field

from core import models
from core.services.meeting_records import RecordConflict, visible_records
from core.services.meeting_summary_versions import SourceReference


class HumanPoint(BaseModel):
    """Human additions may be uncited; supplied citations must still be exact."""

    model_config = ConfigDict(extra="forbid", strict=True)
    text: str = Field(min_length=1, max_length=4000)
    source_refs: list[SourceReference] = Field(max_length=30)


class HumanAction(HumanPoint):
    """Unconfirmed person/deadline labels remain text, never inferred assignments."""

    owner_text: str = Field(max_length=200)
    due_text: str = Field(max_length=200)


class HumanSummary(BaseModel):
    """Preserve structure while clearly identifying content as a human revision."""

    model_config = ConfigDict(extra="forbid", strict=True)
    overview: str = Field(min_length=1, max_length=8000)
    decisions: list[HumanPoint] = Field(max_length=100)
    chapters: list[HumanPoint] = Field(max_length=100)
    action_items: list[HumanAction] = Field(max_length=100)
    open_questions: list[HumanPoint] = Field(max_length=100)


def can_edit(record, user):
    """Only a current manager or independent record owner can create revisions."""
    scoped = visible_records(user, ability="read_summary").filter(pk=record.pk).first()
    return bool(
        settings.MEETING_RECORDS_ENABLED
        and settings.MEETING_SUMMARY_REVIEW_ENABLED
        and scoped
        and (
            scoped.can_generate_summary
            or (
                scoped.source_type != models.MeetingRecord.Source.MEETING
                and scoped.owner_id == user.pk
            )
        )
    )


def serialize(review):
    """Explicit provenance prevents reviewed text from appearing as untouched AI output."""
    if review is None:
        return None
    return {
        "id": str(review.pk),
        "revision": review.revision,
        "base_summary_id": str(review.base_summary_id),
        "previous_id": str(review.previous_id) if review.previous_id else None,
        "input_snapshot_id": str(review.base_summary.input_snapshot_id),
        "author_id": str(review.author_id) if review.author_id else None,
        "created_at": review.created_at,
        "content": review.content,
        "origin": "human",
        "source_revision": review.base_summary.input_snapshot.revision,
    }


def validate_content(content, snapshot):
    """Untrusted text stays inert; references cannot jump to another record or revision."""
    encoded = json.dumps(content, ensure_ascii=False, sort_keys=True)
    if len(encoded.encode()) > 250000:
        raise ValueError("Human summary exceeds the size limit.")
    parsed = HumanSummary.model_validate(content)
    sources = {row["segment_id"]: row for row in snapshot.segments}
    points = [
        *parsed.decisions,
        *parsed.chapters,
        *parsed.action_items,
        *parsed.open_questions,
    ]
    for point in points:
        if not point.text.strip():
            raise ValueError("Summary points cannot be blank.")
        for ref in point.source_refs:
            source = sources.get(ref.segment_id)
            if source is None or any(
                getattr(ref, key) != source[key]
                for key in (
                    "segment_revision",
                    "start_ms",
                    "end_ms",
                )
            ):
                raise ValueError(
                    "Reference does not match the selected summary source."
                )
    if not parsed.overview.strip():
        raise ValueError("Summary overview cannot be blank.")
    return parsed.model_dump()


@transaction.atomic
def save_review(record_id, user, key, payload):
    """Create one revision per explicit intent without advancing source revisions."""
    identity = models.MeetingRecord.objects.get(pk=record_id)
    if identity.meeting_session_id:
        models.MeetingSession.objects.select_for_update().get(
            pk=identity.meeting_session_id
        )
    record = models.MeetingRecord.objects.select_for_update().get(pk=record_id)
    if not can_edit(record, user):
        raise PermissionError
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    existing = models.MeetingSummaryReview.objects.filter(author=user, key=key).first()
    latest = record.summary_reviews.first()
    if existing:
        if existing.record_id != record.pk or existing.request_hash != digest:
            raise RecordConflict("Review key has a different intent.")
        return existing, latest, True
    if payload["expected_revision"] != (latest.revision if latest else 0):
        raise RecordConflict(
            "The human summary changed; refresh without losing your draft."
        )
    base = (
        record.summary_versions.select_related("input_snapshot")
        .filter(pk=payload["base_summary_id"])
        .first()
    )
    if base is None:
        raise RecordConflict("Summary source is unavailable.")
    if latest and latest.base_summary_id != base.pk and not payload["replace_base"]:
        raise RecordConflict("Changing the AI source requires explicit replacement.")
    content = validate_content(payload["content"], base.input_snapshot)
    review = models.MeetingSummaryReview.objects.create(
        record=record,
        base_summary=base,
        previous=latest,
        author=user,
        revision=latest.revision + 1 if latest else 1,
        key=key,
        request_hash=digest,
        content=content,
    )
    return review, review, False
