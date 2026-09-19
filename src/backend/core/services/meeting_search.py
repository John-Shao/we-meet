"""Bounded meeting retrieval using the same live permissions as the record reader."""

from django.conf import settings
from django.db.models import OuterRef, Q, Subquery

from core import models
from core.services.effective_transcripts import current_generation, project
from core.services.meeting_records import visible_records


def recall_records(user, keywords, citations, *, date_from=None, date_to=None):
    """Search current originals and latest minutes, including uploads, without paid reindexing."""
    if not settings.MEETING_RECORDS_ENABLED or not keywords:
        return []
    records = visible_records(user)
    if date_from:
        records = records.filter(origin_at__date__gte=date_from)
    if date_to:
        records = records.filter(origin_at__date__lte=date_to)
    entries = []

    def match(field, title="record__title"):
        predicate = Q()
        for word in keywords:
            predicate |= Q(**{f"{field}__icontains": word}) | Q(
                **{f"{title}__icontains": word}
            )
        return predicate

    def append(
        record, text, *, ability, summary_id=None, start_ms=None, reviewed=False
    ):
        n = len(citations) + 1
        snippet = text[:800]
        citations.append(
            {
                "n": n,
                "kind": "meeting",
                "record_id": str(record.pk),
                "title": record.title or "未命名会议",
                "date": record.origin_at.date().isoformat(),
                "snippet": snippet[:160],
                "ability": ability,
                "summary_id": str(summary_id) if summary_id else None,
                "start_ms": start_ms,
                "reviewed": reviewed,
            }
        )
        entries.append(
            f"[{n}] ({record.origin_at.isoformat()})《{record.title}》{snippet}"
        )

    readable_text = records.filter(can_read_transcript=True)
    originals = project(
        current_generation(
            models.MeetingOriginalSegment.objects.filter(
                record_id__in=readable_text.values("pk"),
            )
        )
    )
    for row in (
        originals.filter(match("corrected_text"))
        .select_related("record", "speaker")
        .order_by("-record__origin_at", "start_ms", "id")[:4]
    ):
        append(
            row.record,
            row.corrected_text,
            ability="read_transcript",
            start_ms=row.start_ms,
        )

    online = models.Transcript.objects.filter(
        session_id__in=readable_text.values("meeting_session_id"),
    ).filter(match("text", "session__record__title"))
    for row in online.select_related("session__record").order_by("-started_at", "id")[
        :4
    ]:
        record = row.session.record
        append(
            record,
            row.text,
            ability="read_transcript",
            start_ms=max(
                0, int((row.started_at - record.origin_at).total_seconds() * 1000)
            ),
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
    # Reviewed text replaces its AI base; superseded wording is never recalled.
    for rows, reviewed in ((reviews, True), (versions, False)):
        for row in (
            rows.filter(match("content"))
            .select_related("record")
            .order_by("-record__origin_at")[:3]
        ):
            content = row.content
            parts = [content.get("overview", "")]
            for kind in ("decisions", "action_items", "chapters", "open_questions"):
                parts.extend(point.get("text", "") for point in content.get(kind, []))
            text = "\n".join(parts)
            position = min(
                (
                    text.lower().find(word.lower())
                    for word in keywords
                    if word.lower() in text.lower()
                ),
                default=0,
            )
            text = text[max(0, position - 150) :][:800]
            append(
                row.record,
                ("人工纪要：" if reviewed else "智能纪要：") + text,
                ability="read_summary",
                summary_id=None if reviewed else row.pk,
                reviewed=reviewed,
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
        from core.services.personal_ai import PersonalAIService

        allowed = {str(pk) for pk in PersonalAIService._user_room_ids(user)}
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
