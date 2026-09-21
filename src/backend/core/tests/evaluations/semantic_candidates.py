"""Test-only full-scan semantic experiment; NOT a production indexing implementation."""

import hashlib
import math
from dataclasses import replace

from django.db.models import OuterRef, Subquery

from core import models
from core.services.effective_transcripts import current_generation, project
from core.services.meeting_records import visible_records
from core.services.meeting_search import Candidate, _select

THRESHOLDS = (0.35, 0.45, 0.55, 0.65, 0.75)


def text_id(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def embedding_text(candidate):
    return candidate.title + "\n" + candidate.text


def cosine(a, b):
    if not a or len(a) != len(b):
        raise ValueError("Vector dimensions must match and be nonempty")
    if any(
        isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x)
        for v in (a, b)
        for x in v
    ):
        raise ValueError("Invalid vector")
    norm = math.sqrt(math.fsum(x * x for x in a) * math.fsum(x * x for x in b))
    if not norm:
        raise ValueError("Zero vector")
    return math.fsum(x * y for x, y in zip(a, b, strict=True)) / norm


def collect(user, *, date_from=None, date_to=None):
    """Read live effective sources before ranking; synthetic test DB only."""
    records = visible_records(user)
    if date_from:
        records = records.filter(origin_at__date__gte=date_from)
    if date_to:
        records = records.filter(origin_at__date__lte=date_to)
    text_records = records.filter(can_read_transcript=True)
    result = []

    def append(  # noqa: PLR0913 -- mirror source citation metadata
        record,
        text,
        ability,
        identity,
        *,
        start_ms=None,
        reviewed=False,
        summary_id=None,
    ):
        # Overlapping windows bound per-citation text. No gold-based window choice.
        for offset in range(0, len(text), 650):
            window = text[offset : offset + 800]
            if window.strip():
                result.append(
                    Candidate(
                        record.id,
                        record.title,
                        record.origin_at,
                        window,
                        ability,
                        0,
                        0,
                        f"{identity}:{offset}",
                        summary_id=summary_id,
                        start_ms=start_ms,
                        reviewed=reviewed,
                    )
                )

    originals = project(
        current_generation(
            models.MeetingOriginalSegment.objects.filter(
                record_id__in=text_records.values("pk")
            )
        )
    ).select_related("record")
    for row in originals:
        append(
            row.record,
            row.corrected_text,
            "read_transcript",
            "original:" + str(row.pk),
            start_ms=row.start_ms,
        )
    online = models.Transcript.objects.filter(
        session_id__in=text_records.values("meeting_session_id")
    ).select_related("session__record")
    for row in online:
        record = row.session.record
        append(
            record,
            row.text,
            "read_transcript",
            "online:" + str(row.pk),
            start_ms=max(
                0, int((row.started_at - record.origin_at).total_seconds() * 1000)
            ),
        )
    summary_records = records.filter(can_read_summary=True)
    latest_review = (
        models.MeetingSummaryReview.objects.filter(record_id=OuterRef("record_id"))
        .order_by("-revision")
        .values("pk")[:1]
    )
    reviews = models.MeetingSummaryReview.objects.filter(
        record_id__in=summary_records.values("pk"), pk=Subquery(latest_review)
    )
    latest_ai = (
        models.MeetingSummaryVersion.objects.filter(record_id=OuterRef("record_id"))
        .order_by("-created_at", "-id")
        .values("pk")[:1]
    )
    versions = models.MeetingSummaryVersion.objects.filter(
        record_id__in=summary_records.values("pk"), pk=Subquery(latest_ai)
    ).exclude(record_id__in=reviews.values("record_id"))
    for source, reviewed in ((reviews, True), (versions, False)):
        for row in source.select_related("record"):
            parts = [row.content.get("overview", "")]
            for kind in ("decisions", "action_items", "chapters", "open_questions"):
                parts.extend(p.get("text", "") for p in row.content.get(kind, []))
            append(
                row.record,
                "\n".join(parts),
                "read_summary",
                "summary:" + str(row.pk),
                reviewed=reviewed,
                summary_id=None if reviewed else str(row.pk),
            )
    return result


def ranked(candidates, question, vectors):
    query = vectors[text_id(question)]
    return [
        replace(c, body_score=cosine(query, vectors[text_id(embedding_text(c))]))
        for c in candidates
    ]


def render(candidates, citations, threshold):
    entries = []
    for c in _select([c for c in candidates if c.body_score >= threshold]):
        n = len(citations) + 1
        citations.append(
            {
                "n": n,
                "kind": "meeting",
                "record_id": str(c.record_id),
                "title": c.title,
                "date": c.date.date().isoformat(),
                "snippet": c.text[:160],
                "ability": c.ability,
                "summary_id": c.summary_id,
                "start_ms": c.start_ms,
                "reviewed": c.reviewed,
            }
        )
        entries.append(f"[{n}] ({c.date.isoformat()})《{c.title}》{c.text}")
    return entries
