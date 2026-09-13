"""Freeze private completion events for final versioned summaries, never legacy broadcasts."""

import hashlib
import json
from functools import partial
from urllib.parse import urlsplit

from django.conf import settings
from django.db import transaction

from core import models
from core.services import im_cards
from core.services.im_delivery_client import ImDeliveryClient
from core.services.meeting_records import RecordConflict, visible_records


def enabled():
    return bool(
        settings.MEETING_RECORDS_ENABLED
        and settings.MEETING_SUMMARY_NOTIFICATIONS_ENABLED
        and settings.CELERY_ENABLED
    )


def body_hash(body):
    return hashlib.sha256(body.encode()).hexdigest()


def _dispatch(pk):
    from core.services.summary_notification_delivery import (  # noqa: PLC0415 -- avoid completion/delivery cycle
        dispatch_notification,
    )

    return dispatch_notification(pk)


def _origins():
    config = settings.JUSI_IM_CONFIGURATION or {}
    api_url = str(config.get("api_url", "")).rstrip("/")
    ImDeliveryClient(api_url, config.get("admin_hmac_secret", ""))
    base = str(settings.APPLICATION_BASE_URL or "").rstrip("/")
    parsed = urlsplit(base)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.path
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("Configure the public application origin.")
    return api_url, base


def available():
    if not enabled():
        return False
    try:
        _origins()
    except (ValueError, TypeError):
        return False
    return True


def recipient_candidates(record, initiator_id=None):
    """Current room owners and actual request initiators; speaker names never become accounts."""
    ids = set()
    if record.source_type != models.MeetingRecord.Source.MEETING:
        ids.add(record.owner_id)
    else:
        ids.update(
            models.ResourceAccess.objects.filter(
                resource_id=record.meeting_session.room_id,
                role=models.RoleChoices.OWNER,
            ).values_list("user_id", flat=True)
        )
        ids.update(record.online_captures.values_list("requested_by_id", flat=True))
        if initiator_id:
            ids.add(initiator_id)
    ids.discard(None)
    if len(ids) > 100:
        raise RecordConflict("Too many notification recipients.")
    return [
        user
        for user in models.User.objects.filter(pk__in=ids, is_active=True).order_by(
            "id"
        )
        if visible_records(user, ability="read_summary").filter(pk=record.pk).exists()
    ]


def build_body(row, base):
    metadata = row.source_metadata
    zh = metadata["language"].startswith("zh")
    heading = "智能纪要已生成" if zh else "Meeting minutes are ready"
    title = metadata["title"]
    kinds = {
        "meeting": ("线上会议", "Online meeting"),
        "audio_recording": ("AI 录音", "AI recording"),
        "upload": ("音视频上传", "Uploaded media"),
    }
    source = kinds[metadata["source_type"]][0 if zh else 1]
    url = f"{base}/meeting/records/{row.record_id}"
    card = im_cards.build_rich_card(
        header={"title": heading, "theme": "info"},
        plain=f"{heading} · {title}",
        blocks=[
            {"type": "text", "spans": [{"tag": "text", "text": title}]},
            {
                "type": "fields",
                "items": [
                    {"label": "来源" if zh else "Source", "value": source},
                    {
                        "label": "发生时间" if zh else "Recorded at",
                        "value": metadata["origin_at"],
                    },
                    {
                        "label": "纪要版本时间" if zh else "Version created",
                        "value": metadata["version_created_at"],
                    },
                ],
            },
            {
                "type": "text",
                "spans": [
                    {
                        "tag": "text",
                        "text": "根据已保存的文字生成，请在纪要中核对来源覆盖范围。"
                        if zh
                        else "Generated from saved text. Check source coverage in the minutes.",
                    }
                ],
            },
            {
                "type": "actions",
                "buttons": [
                    {
                        "id": "open-note",
                        "text": "查看笔记" if zh else "Open note",
                        "style": "default",
                        "action": "url",
                        "url": url,
                    },
                    {
                        "id": "open-minutes",
                        "text": "查看纪要" if zh else "Open minutes",
                        "style": "primary",
                        "action": "url",
                        "url": f"{url}?summary={row.summary_id}",
                    },
                ],
            },
        ],
    )
    return json.dumps(card, ensure_ascii=False, separators=(",", ":"))


@transaction.atomic
def record_completion(version):
    """Persist the recipient set with the published final; dispatch is a separate concern."""
    if not enabled() or version.stage != "final":
        return []
    record = models.MeetingRecord.objects.select_for_update().get(pk=version.record_id)
    existing = list(record.summary_notifications.filter(summary=version).order_by("id"))
    if models.MeetingSummaryNotificationEvent.objects.filter(summary=version).exists():
        return existing
    initiator = version.job.configuration.get("requested_by")
    try:
        users = [user for user in recipient_candidates(record, initiator) if user.sub]
    except (RecordConflict, ValueError):
        models.MeetingSummaryNotificationEvent.objects.create(
            summary=version, error_code="recipient_selection_failed"
        )
        return []
    models.MeetingSummaryNotificationEvent.objects.create(
        summary=version, recipient_ids=[str(user.pk) for user in users]
    )
    rows = []
    for user in users:
        rows.append(
            models.MeetingSummaryNotification.objects.create(
                record=record,
                summary=version,
                recipient=user,
                recipient_sub=user.sub,
                source_metadata={
                    "title": record.title[:255],
                    "source_type": record.source_type,
                    "origin_at": record.origin_at.isoformat(),
                    "version_created_at": version.created_at.isoformat(),
                    "language": str(user.language or "en"),
                },
            )
        )
        transaction.on_commit(partial(_dispatch, rows[-1].pk), robust=True)
    return rows


def serialize(row):
    return {
        "id": str(row.pk),
        "summary_id": str(row.summary_id),
        "status": row.status,
        "attempt": row.attempt,
        "error_code": row.error_code,
        "created_at": row.created_at,
    }
