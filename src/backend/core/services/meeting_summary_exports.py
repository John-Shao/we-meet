"""Explicit immutable summary exports; external document creation uses durable keys."""

import hashlib
import html
import json
import re
from urllib.parse import urlsplit

from django.conf import settings
from django.db import transaction

from core import models
from core.services.docs_delivery_client import DocsDeliveryClient
from core.services.meeting_records import RecordConflict, visible_records
from core.services.meeting_summary_review import validate_content


def available():
    """New export consent is separate from summary generation and human review flags."""
    config = settings.DOCS_CONFIGURATION
    return bool(
        settings.MEETING_RECORDS_ENABLED
        and settings.MEETING_SUMMARY_EXPORT_ENABLED
        and settings.CELERY_ENABLED
        and config.get("api_url")
        and config.get("server_to_server_token")
    )


def can_export(record, user):
    """Only a current room manager or native record owner may deliver a new copy."""
    if not user or not models.User.objects.filter(pk=user.pk, is_active=True).exists():
        return False
    scoped = visible_records(user, ability="read_summary").filter(pk=record.pk).first()
    return bool(
        scoped
        and (
            scoped.can_generate_summary
            or (
                scoped.source_type != models.MeetingRecord.Source.MEETING
                and scoped.owner_id == user.pk
            )
        )
    )


def digest(value):
    return hashlib.sha256(
        json.dumps(
            value, sort_keys=True, ensure_ascii=False, separators=(",", ":")
        ).encode()
    ).hexdigest()


def _plain(value):
    """Model/human text stays literal; it cannot insert Markdown media or raw HTML."""
    escaped = html.escape(str(value), quote=False)
    return re.sub(r"([\\`*_{}\[\]()#+.!|~\-])", r"\\\1", escaped)


def _source(record, source_kind, source_id):
    if source_kind == "human":
        review = (
            record.summary_reviews.select_related("base_summary__input_snapshot")
            .filter(pk=source_id)
            .first()
        )
        if not review:
            raise RecordConflict("Selected human revision is unavailable.")
        return review.base_summary, review, review.content
    summary = (
        record.summary_versions.select_related("input_snapshot")
        .filter(pk=source_id)
        .first()
    )
    if not summary:
        raise RecordConflict("Selected AI version is unavailable.")
    return summary, None, summary.content


def render_payload(record, user, selection):
    """Generate preview and frozen Markdown from the exact selected immutable source."""
    summary, review, content = _source(
        record, selection["source_kind"], selection["source_id"]
    )
    content = validate_content(content, summary.input_snapshot)
    chinese = selection["language"] == "zh"
    labels = (
        ("总结", "关键结论", "话题纪要", "待确认行动项", "待解决问题")
        if chinese
        else ("Overview", "Decisions", "Topics", "Actions to confirm", "Open questions")
    )
    origin = (
        (f"人工修订版本 {review.revision}" if review else "AI 生成版本")
        if chinese
        else (f"Human revision {review.revision}" if review else "AI-generated version")
    )
    title = (record.title or ("会议纪要" if chinese else "Meeting minutes"))[:255]
    lines = [
        f"# {_plain(title)}",
        "",
        origin,
        "",
        record.origin_at.isoformat(),
        "",
        f"## {labels[0]}",
        "",
        _plain(content["overview"]),
    ]
    for name, label in zip(
        ("decisions", "chapters", "action_items", "open_questions"),
        labels[1:],
        strict=True,
    ):
        if not content[name]:
            continue
        lines.extend(["", f"## {label}", ""])
        for point in content[name]:
            lines.append(f"- {_plain(point['text'])}")
            if name == "action_items":
                lines.append(
                    f"  {_plain(point['owner_text'])} / {_plain(point['due_text'])}"
                )
            times = [
                f"{ref['start_ms'] // 60000}:{ref['start_ms'] // 1000 % 60:02d}"
                for ref in point["source_refs"]
            ]
            if times:
                lines.append(
                    f"  {'原文时间' if chinese else 'Source time'}: {', '.join(times)}"
                )
    payload = {"sub": str(user.sub or ""), "title": title, "content": "\n".join(lines)}
    if not payload["sub"] or len(payload["content"].encode()) > 2000000:
        raise ValueError("Export content or owner identity is unavailable.")
    return summary, review, payload


def serialize(export):
    """Expose progress and provenance; never release frozen content or service tokens."""
    return {
        "id": str(export.pk),
        "source_kind": export.source_kind,
        "source_id": str(export.source_id),
        "language": export.language,
        "status": export.status,
        "attempt": export.attempt,
        "document_id": str(export.document_id) if export.document_id else None,
        "error_code": export.error_code,
        "created_at": export.created_at,
    }


@transaction.atomic
def request_export(record_id, user, key, selection, expected_hash):
    """One document per selected version/owner/language; all retries reuse its key."""
    models.User.objects.select_for_update().get(pk=user.pk)
    record = models.MeetingRecord.objects.select_for_update().get(pk=record_id)
    if not can_export(record, user):
        raise PermissionError
    request_hash = digest(
        {"record_id": str(record_id), "expected_hash": expected_hash, **selection}
    )
    previous = (
        models.MeetingSummaryExportRequest.objects.filter(requested_by=user, key=key)
        .select_related("export")
        .first()
    )
    if previous:
        if previous.request_hash != request_hash:
            raise RecordConflict("Export request key conflicts.")
        return previous.export, True
    if not available():
        raise PermissionError
    config = settings.DOCS_CONFIGURATION
    api_url = str(config["api_url"]).rstrip("/")
    # Validate only operator configuration. The token is never copied into a row.
    DocsDeliveryClient(api_url, config["server_to_server_token"])
    if urlsplit(api_url).path not in {"", "/"}:
        raise ValueError("Configure the Docs service origin without an API path.")
    export = models.MeetingSummaryExport.objects.filter(
        record=record,
        requested_by=user,
        **selection,
    ).first()
    if export is None:
        summary, review, payload = render_payload(record, user, selection)
        if digest(payload) != expected_hash:
            raise RecordConflict("Export preview changed; review the new copy first.")
        export = models.MeetingSummaryExport.objects.create(
            record=record,
            requested_by=user,
            summary=summary,
            review=review,
            api_url=api_url,
            payload=payload,
            payload_hash=digest(payload),
            **selection,
        )
    elif export.payload_hash != expected_hash:
        raise RecordConflict("The existing document uses a different frozen preview.")
    models.MeetingSummaryExportRequest.objects.create(
        requested_by=user,
        key=key,
        request_hash=request_hash,
        export=export,
        attempt=export.attempt,
    )
    return export, False
