"""Bounded lexical retrieval with live permissions, record diversity and evidence windows."""

from dataclasses import dataclass
from datetime import datetime

from django.conf import settings
from django.db.models import (
    Case,
    F,
    IntegerField,
    OuterRef,
    Q,
    Subquery,
    Value,
    When,
    Window,
)
from django.db.models.functions import Greatest, Lower, RowNumber, StrIndex, Substr

from core import models
from core.services.effective_transcripts import current_generation, project
from core.services.meeting_records import visible_records

# Pools are bounded independently; final context has one shared budget.
CANDIDATES_PER_SOURCE = 64
CANDIDATES_PER_RECORD = 2
CONTEXT_CITATIONS = 8
CONTEXT_CHARS = 800


@dataclass(frozen=True)
class Candidate:
    record_id: object
    title: str
    date: datetime
    text: str
    ability: str
    body_score: int
    title_score: int
    identity: str
    summary_id: object = None
    start_ms: int | None = None
    reviewed: bool = False


def _score_expression(field, keywords):
    return sum(
        (
            Case(
                When(
                    **{
                        f"{field}__icontains": word,
                        "then": Value(len(keywords) - index),
                    }
                ),
                default=Value(0),
                output_field=IntegerField(),
            )
            for index, word in enumerate(keywords)
        ),
        Value(0),
    )


def _pool(rows, keywords, *, field, record_field="record", time_field="start_ms"):
    """Apply per-record quota in SQL BEFORE the bounded global pool is materialized."""
    title = f"{record_field}__title"
    return (
        rows.annotate(
            _body_score=_score_expression(field, keywords),
            _title_score=_score_expression(title, keywords),
        )
        .filter(Q(_body_score__gt=0) | Q(_title_score__gt=0))
        .annotate(
            _record_rank=Window(
                expression=RowNumber(),
                partition_by=[F(f"{record_field}__id")],
                order_by=[
                    F("_body_score").desc(),
                    F("_title_score").desc(),
                    F(time_field).asc(),
                    F("id").asc(),
                ],
            )
        )
        .filter(_record_rank__lte=CANDIDATES_PER_RECORD)
        .order_by(
            "-_body_score",
            "-_title_score",
            f"-{record_field}__origin_at",
            time_field,
            "id",
        )
    )


def _window_expression(field, keywords):
    # Prefer the highest-priority matching term. A title-only match uses the prefix.
    position = Case(
        *(
            When(
                **{
                    f"{field}__icontains": word,
                    "then": StrIndex(Lower(F(field)), Value(word.lower())),
                }
            )
            for word in keywords
        ),
        default=Value(1),
        output_field=IntegerField(),
    )
    return Substr(field, Greatest(position - Value(150), Value(1)), CONTEXT_CHARS)


def _text_score(text, keywords):
    return sum(
        len(keywords) - index
        for index, word in enumerate(keywords)
        if word.lower() in text.lower()
    )


def _text_window(text, keywords, limit):
    position = next(
        (
            text.lower().find(word.lower())
            for word in keywords
            if word.lower() in text.lower()
        ),
        0,
    )
    start = max(0, position - 150)
    return text[start : start + limit]


def _select(candidates):
    ranked = sorted(
        candidates,
        key=lambda c: (
            -c.body_score,
            -c.title_score,
            -c.date.timestamp(),
            not c.reviewed,
            c.start_ms if c.start_ms is not None else 0,
            c.identity,
        ),
    )
    groups, seen = {}, set()
    for candidate in ranked:
        key = (candidate.record_id, candidate.text.strip().casefold())
        if key in seen:
            continue
        seen.add(key)
        group = groups.setdefault(candidate.record_id, [])
        if len(group) < CANDIDATES_PER_RECORD:
            group.append(candidate)
    # Best evidence from each record precedes a second fragment from any record.
    return [
        group[index]
        for index in range(CANDIDATES_PER_RECORD)
        for group in groups.values()
        if len(group) > index
    ][:CONTEXT_CITATIONS]


def recall_records(user, keywords, citations, *, date_from=None, date_to=None):
    """Search effective originals/latest minutes without embeddings or paid expansion."""
    keywords = list(dict.fromkeys(word for word in keywords if word))[:3]
    if not settings.MEETING_RECORDS_ENABLED or not keywords:
        return []
    records = visible_records(user)
    if date_from:
        records = records.filter(origin_at__date__gte=date_from)
    if date_to:
        records = records.filter(origin_at__date__lte=date_to)
    candidates = []
    readable_text = records.filter(can_read_transcript=True)
    originals = project(
        current_generation(
            models.MeetingOriginalSegment.objects.filter(
                record_id__in=readable_text.values("pk")
            )
        )
    )
    rows = (
        _pool(originals, keywords, field="corrected_text")
        .annotate(_context=_window_expression("corrected_text", keywords))
        .values(
            "id",
            "record_id",
            "record__title",
            "record__origin_at",
            "start_ms",
            "_context",
            "_body_score",
            "_title_score",
        )[:CANDIDATES_PER_SOURCE]
    )
    for row in rows:
        candidates.append(
            Candidate(
                row["record_id"],
                row["record__title"],
                row["record__origin_at"],
                row["_context"],
                "read_transcript",
                row["_body_score"],
                row["_title_score"],
                str(row["id"]),
                start_ms=row["start_ms"],
            )
        )
    online = models.Transcript.objects.filter(
        session_id__in=readable_text.values("meeting_session_id")
    )
    rows = (
        _pool(
            online,
            keywords,
            field="text",
            record_field="session__record",
            time_field="started_at",
        )
        .annotate(_context=_window_expression("text", keywords))
        .values(
            "id",
            "session__record__id",
            "session__record__title",
            "session__record__origin_at",
            "started_at",
            "_context",
            "_body_score",
            "_title_score",
        )[:CANDIDATES_PER_SOURCE]
    )
    for row in rows:
        at = row["session__record__origin_at"]
        candidates.append(
            Candidate(
                row["session__record__id"],
                row["session__record__title"],
                at,
                row["_context"],
                "read_transcript",
                row["_body_score"],
                row["_title_score"],
                str(row["id"]),
                start_ms=max(0, int((row["started_at"] - at).total_seconds() * 1000)),
            )
        )
    readable_summary = records.filter(can_read_summary=True)
    latest_review = (
        models.MeetingSummaryReview.objects.filter(record_id=OuterRef("record_id"))
        .order_by("-revision")
        .values("pk")[:1]
    )
    reviews = models.MeetingSummaryReview.objects.filter(
        record_id__in=readable_summary.values("pk"), pk=Subquery(latest_review)
    )
    latest = (
        models.MeetingSummaryVersion.objects.filter(record_id=OuterRef("record_id"))
        .order_by("-created_at", "-id")
        .values("pk")[:1]
    )
    versions = models.MeetingSummaryVersion.objects.filter(
        record_id__in=readable_summary.values("pk"), pk=Subquery(latest)
    ).exclude(record_id__in=reviews.values("record_id"))
    # Human review replaces its AI base, regardless of whether the review matches.
    for source, reviewed in ((reviews, True), (versions, False)):
        rows = _pool(source, keywords, field="content", time_field="created_at").values(
            "id",
            "record_id",
            "record__title",
            "record__origin_at",
            "content",
        )[:CANDIDATES_PER_SOURCE]
        for row in rows:
            content = row["content"]
            parts = [content.get("overview", "")]
            for kind in ("decisions", "action_items", "chapters", "open_questions"):
                parts.extend(point.get("text", "") for point in content.get(kind, []))
            text = "\n".join(parts)
            body_score, title_score = (
                _text_score(text, keywords),
                _text_score(row["record__title"], keywords),
            )
            if not body_score and not title_score:
                continue  # JSON keys/reference metadata are not evidence.
            candidates.append(
                Candidate(
                    row["record_id"],
                    row["record__title"],
                    row["record__origin_at"],
                    text,
                    "read_summary",
                    body_score,
                    title_score,
                    str(row["id"]),
                    summary_id=None if reviewed else row["id"],
                    reviewed=reviewed,
                )
            )
    entries = []
    for candidate in _select(candidates):
        prefix = (
            ("人工纪要：" if candidate.reviewed else "智能纪要：")
            if candidate.ability == "read_summary"
            else ""
        )
        text = prefix + (
            _text_window(candidate.text, keywords, CONTEXT_CHARS - len(prefix))
            if prefix
            else candidate.text
        )
        n = len(citations) + 1
        citations.append(
            {
                "n": n,
                "kind": "meeting",
                "record_id": str(candidate.record_id),
                "title": candidate.title or "未命名会议",
                "date": candidate.date.date().isoformat(),
                "snippet": text[:160],
                "ability": candidate.ability,
                "summary_id": str(candidate.summary_id)
                if candidate.summary_id
                else None,
                "start_ms": candidate.start_ms,
                "reviewed": candidate.reviewed,
            }
        )
        entries.append(
            f"[{n}] ({candidate.date.isoformat()})《{candidate.title}》{text}"
        )
    return entries


def citations_visible(user, citations):
    """Recheck record permissions before returning model output or streaming another chunk."""
    legacy_rooms = {
        row["room_id"]
        for row in citations
        if row.get("room_id") and not row.get("record_id")
    }
    if legacy_rooms:
        from core.services.personal_ai import (  # noqa: PLC0415 -- service import cycle
            PersonalAIService,
        )

        allowed = {str(pk) for pk in PersonalAIService._user_room_ids(user)}  # noqa: SLF001 -- same live legacy ACL
        if not legacy_rooms.issubset(allowed):
            return False
    for ability in ("read_summary", "read_transcript"):
        ids = {
            row["record_id"]
            for row in citations
            if row.get("record_id") and row.get("ability") == ability
        }
        if ids and visible_records(user, ability=ability).filter(
            pk__in=ids
        ).count() != len(ids):
            return False
    return True
